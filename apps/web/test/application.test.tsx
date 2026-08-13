// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebApplication } from '../src/application.js';
import type { CapabilityClient, LocalJobClient } from '@local-pii/sdk';
import { preflightSelectedFile } from '../src/file-preflight.js';
import { createRedactedTextPreview } from '../src/redacted-preview.js';

const scanJobId = 'job_01J4M91NJK8WAPJ7J95K73CB2M';
const firstDetectionId = '123e4567-e89b-42d3-a456-426614174011';
const secondDetectionId = '123e4567-e89b-42d3-a456-426614174012';
const extractionRevision = `sha256:${'d'.repeat(64)}`;
const emptyReview = {
  schemaVersion: '1.0.0',
  jobId: scanJobId,
  jobRevision: 6,
  extractionRevision,
  reviewRevision: 0,
  digest: `sha256:${'e'.repeat(64)}`,
  decisions: []
} as const;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

function readyClient(): CapabilityClient {
  return {
    load: () => Promise.resolve({
      schemaVersion: '1.0.0',
      supportedContractVersions: ['1.0.0'],
      engineMode: 'RULES_ONLY',
      formatCount: 3,
      availableDetectorCount: 1,
      maximumInputBytes: 104_857_600,
      supportedFiles: [
        { extension: '.json', maximumInputBytes: 104_857_600, supportsRedaction: true },
        { extension: '.markdown', maximumInputBytes: 104_857_600, supportsRedaction: true },
        { extension: '.md', maximumInputBytes: 104_857_600, supportsRedaction: true },
        { extension: '.txt', maximumInputBytes: 104_857_600, supportsRedaction: true }
      ],
      supportedEntityTypes: ['EMAIL', 'PHONE', 'SSN', 'CREDIT_CARD']
    })
  };
}

function readyJobClient(): LocalJobClient {
  const unavailable = (): Promise<never> => Promise.reject(new Error('NOT_IMPLEMENTED'));
  const completedJob = {
    id: scanJobId, operation: 'SCAN' as const, state: 'SUCCEEDED' as const,
    revision: 6,
    policy: { id: 'development-labels', version: '0.1.0', digest: `sha256:${'a'.repeat(64)}` },
    createdAt: '2026-08-09T12:00:00.000Z', updatedAt: '2026-08-09T12:00:01.000Z'
  };
  const page = {
    jobId: completedJob.id,
    jobRevision: 6,
    detections: 1,
    conflicts: 0,
    byEntity: { EMAIL: 1 } as const,
    cursor: 0,
    nextCursor: null,
    details: [{ id: firstDetectionId, entityType: 'EMAIL' as const, start: 19, end: 46, confidence: 0.99, sources: ['REGEX' as const] }],
    conflictDetails: [],
    conflictDetailsLimited: false
  };
  const redactedBytes = new TextEncoder().encode('Synthetic contact: [EMAIL_1]\n<script>not executable</script>');
  return {
    loadPolicies: () => Promise.resolve({
      defaultPolicy: {
        id: 'development-labels', version: '0.1.0', digest: `sha256:${'a'.repeat(64)}`,
        riskTier: 'LOW', example: true
      },
      policies: [{
        id: 'development-labels', version: '0.1.0', digest: `sha256:${'a'.repeat(64)}`,
        riskTier: 'LOW', example: true
      }]
    }),
    scan: () => Promise.resolve({
      ...page, outcome: 'SUCCEEDED', job: completedJob,
      review: emptyReview,
      events: [{
        id: '123e4567-e89b-42d3-a456-426614174000', cursor: 1, revision: 1,
        type: 'JOB_CREATED', occurredAt: completedJob.createdAt
      }]
    }),
    redact: () => Promise.resolve({
      job: {
        ...completedJob,
        operation: 'REDACT',
        state: 'VERIFIED',
        revision: 8
      },
      output: {
        id: 'art_01J4M91NJK8WAPJ7J95K73CB2N',
        mediaType: 'text/plain',
        byteLength: redactedBytes.byteLength,
        digest: `sha256:${'c'.repeat(64)}`,
        displayName: 'document.redacted.txt',
        bytes: redactedBytes
      }
    }),
    listDetections: () => Promise.resolve(page),
    getReviewSet: () => Promise.resolve(emptyReview),
    appendReviewDecisions: (_jobId, _jobRevision, _extraction, _reviewRevision, decisions) => Promise.resolve({
      ...emptyReview,
      reviewRevision: decisions.length,
      decisions: decisions.map((decision, index) => ({
        ...decision, revision: index + 1, principal: 'LOCAL_SESSION' as const,
        occurredAt: '2026-08-09T12:00:02.000Z'
      }))
    }),
    scanPreview: () => Promise.resolve({
      outcome: 'SUCCEEDED', detections: 1, conflicts: 0, byEntity: { EMAIL: 1 },
      details: [{ entityType: 'EMAIL', start: 19, end: 46, confidence: 0.99, sources: ['REGEX'] }],
      detailsLimited: false, conflictDetails: [], conflictDetailsLimited: false
    }),
    create: unavailable,
    get: unavailable,
    listEvents: unavailable,
    cancel: unavailable,
    expire: () => Promise.resolve()
  };
}

describe('web application foundation', () => {
  it('bounds redacted text previews on Unicode code-point boundaries', () => {
    const bytes = new TextEncoder().encode('\uFEFFa😀bcd');
    expect(createRedactedTextPreview(bytes, 3)).toEqual({ text: 'a😀b', codePoints: 3, truncated: true });
    expect(createRedactedTextPreview(new TextEncoder().encode('complete'), 20)).toEqual({
      text: 'complete', codePoints: 8, truncated: false
    });
  });

  it('renders the capability preflight as an accessible local-first journey', async () => {
    const { container } = render(<WebApplication capabilityClient={readyClient()} jobClient={readyJobClient()} />);

    expect(await screen.findByText('Local engine is ready')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Your document stays under your control.' })).toBeTruthy();
    expect(screen.getByText('8 MiB')).toBeTruthy();
    expect(screen.getByText('Development labels')).toBeTruthy();
    expect(screen.getByLabelText('Document file')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(document.documentElement.lang).toBe('en');
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('checks only selected file metadata without copying its name into application status', async () => {
    const user = userEvent.setup();
    render(<WebApplication capabilityClient={readyClient()} jobClient={readyJobClient()} />);
    await screen.findByText('Local engine is ready');
    const input = screen.getByLabelText('Document file');
    const selected = new File([new Uint8Array(1024)], 'private-customer-record.md', { type: 'text/markdown' });

    await user.upload(input, selected);

    expect(screen.getByText('MD file, 1 KiB, passes the local preflight checks.')).toBeTruthy();
    expect(screen.queryByText('private-customer-record.md')).toBeNull();
    expect(screen.getByText(/Browser persistence and durable artifact storage remain disabled/u)).toBeTruthy();
  });

  it('keeps detected text hidden until the reviewer explicitly reveals the local match', async () => {
    const user = userEvent.setup();
    const { container } = render(<WebApplication capabilityClient={readyClient()} jobClient={readyJobClient()} />);
    await screen.findByText('Local engine is ready');
    const selected = new File(['Synthetic contact: preview-canary@example.test'], 'private-source.txt', {
      type: 'text/plain'
    });

    await user.upload(screen.getByLabelText('Document file'), selected);
    await user.click(screen.getByRole('button', { name: 'Scan locally' }));

    expect(await screen.findByText('1 potential item found.')).toBeTruthy();
    expect(screen.getByText('Job activity')).toBeTruthy();
    expect(screen.getByText('Job created')).toBeTruthy();
    expect(screen.getAllByText('Email addresses').length).toBeGreaterThan(1);
    expect(screen.getByRole('heading', { level: 3, name: 'Detection details' })).toBeTruthy();
    expect(screen.getByLabelText('Filter detections')).toBeTruthy();
    expect(screen.getByText('Characters 20–46')).toBeTruthy();
    expect(screen.getByText('Detector confidence: 99%')).toBeTruthy();
    expect(screen.getByText('Evidence source: pattern rule')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Category' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Detected text' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Location' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Confidence' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Evidence sources' })).toBeTruthy();
    expect(screen.getByText('Saved reviewer decisions: 0 of 1.')).toBeTruthy();
    expect(screen.getByText(/These follow the automatic policy/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Previous detection' })).toBeNull();
    expect(screen.queryByText('preview-canary@example.test')).toBeNull();
    expect(screen.queryByText('private-source.txt')).toBeNull();
    const reveal = screen.getByRole('button', { name: 'Show detected text' });
    expect(reveal.getAttribute('aria-pressed')).toBe('false');
    await user.click(reveal);
    expect(await screen.findByText('preview-canary@example.test')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide detected text' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'View source context' }));
    const sourceContext = await screen.findByRole('region', {
      name: 'Highlighted detected text in its local source context'
    });
    expect(sourceContext.textContent).toContain('Synthetic contact: preview-canary@example.test');
    expect(sourceContext.querySelector('mark')?.textContent).toBe('preview-canary@example.test');
    await waitFor(() => { expect(document.activeElement).toBe(sourceContext); });
    await user.click(screen.getByRole('button', { name: 'Hide detected text' }));
    await waitFor(() => { expect(screen.queryByText('preview-canary@example.test')).toBeNull(); });
    expect(screen.queryByRole('heading', { name: 'Source context' })).toBeNull();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('admits JSON while keeping raw detected text and source context unavailable', async () => {
    const user = userEvent.setup();
    render(<WebApplication capabilityClient={readyClient()} jobClient={readyJobClient()} />);
    await screen.findByText('Local engine is ready');
    const selected = new File(['{"contact":"structured@example.test"}'], 'private-source.json', {
      type: 'application/json'
    });
    const localRead = vi.spyOn(selected, 'arrayBuffer');
    await user.upload(screen.getByLabelText('Document file'), selected);
    expect(screen.getByText(/JSON file.+passes the local preflight checks/u)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Scan locally' }));
    expect(await screen.findByText('1 potential item found.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show detected text' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'View source context' })).toBeNull();
    expect(screen.getByText(/Detected text and source context stay hidden for JSON and CSV/u)).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(localRead).not.toHaveBeenCalled();
    expect(screen.queryByText('structured@example.test')).toBeNull();
    expect(screen.queryByText('private-source.json')).toBeNull();
  });

  it('renders an escaped verified preview before offering the download', async () => {
    const createObjectUrl = vi.fn(() => 'blob:local-verified-output');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    const automaticDownload = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const user = userEvent.setup();
    const { container, unmount } = render(
      <WebApplication capabilityClient={readyClient()} jobClient={readyJobClient()} />
    );
    await screen.findByText('Local engine is ready');
    const sourceValue = 'browser-redaction@example.test';
    await user.upload(
      screen.getByLabelText('Document file'),
      new File([`Synthetic contact: ${sourceValue}`], 'private-source.txt', { type: 'text/plain' })
    );
    await user.click(screen.getByRole('button', { name: 'Scan locally' }));
    await screen.findByText('1 potential item found.');
    await user.click(screen.getByRole('button', { name: 'Redact and preview' }));

    expect(await screen.findByText(
      'The redacted copy passed verification. Review the preview before downloading.'
    )).toBeTruthy();
    const download = screen.getByRole('link', { name: 'Download verified redacted copy' });
    expect(download.getAttribute('href')).toBe('blob:local-verified-output');
    expect(download.getAttribute('download')).toBe('document.redacted.txt');
    expect(container.textContent).not.toContain(sourceValue);
    const previewRegion = screen.getByRole('region', { name: 'Verified redacted output preview' });
    expect(previewRegion.textContent).toContain('<script>not executable</script>');
    previewRegion.focus();
    expect(document.activeElement).toBe(previewRegion);
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('Showing the complete verified output.')).toBeTruthy();
    expect(automaticDownload).not.toHaveBeenCalled();
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);

    unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:local-verified-output');
  });

  it('confirms and expires redaction before scan when clearing the current workflow', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:local-output') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const base = readyJobClient();
    const redactionJobId = 'job_01J4M91NJK8WAPJ7J95K73CB2N';
    const expire = vi.fn<LocalJobClient['expire']>(() => Promise.resolve());
    const jobs: LocalJobClient = {
      ...base,
      redact: async (...parameters) => {
        const summary = await base.redact(...parameters);
        return { ...summary, job: { ...summary.job, id: redactionJobId } };
      },
      expire
    };
    const user = userEvent.setup();
    const { container } = render(<WebApplication capabilityClient={readyClient()} jobClient={jobs} />);
    await screen.findByText('Local engine is ready');
    await user.upload(screen.getByLabelText('Document file'), new File(['synthetic'], 'synthetic.txt'));
    await user.click(screen.getByRole('button', { name: 'Scan locally' }));
    await screen.findByText('1 potential item found.');
    await user.click(screen.getByRole('button', { name: 'Redact and preview' }));
    await screen.findByRole('link', { name: 'Download verified redacted copy' });

    await user.click(screen.getByRole('button', { name: 'Clear current workflow' }));
    expect(screen.getByRole('heading', { name: 'Clear this document workflow now?' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep workflow' }));
    expect(expire).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Download verified redacted copy' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Clear current workflow' }));
    await user.click(screen.getByRole('button', { name: 'Clear now' }));
    expect(await screen.findByText('The current workflow was cleared from this application session.')).toBeTruthy();
    expect(expire.mock.calls.map(([jobId]) => jobId)).toEqual([redactionJobId, scanJobId]);
    expect(screen.getByText('No document is selected.')).toBeTruthy();
    const resetFileInput = screen.getByLabelText('Document file');
    if (!(resetFileInput instanceof HTMLInputElement)) throw new TypeError('The file control is unavailable.');
    expect(resetFileInput.files?.length).toBe(0);
    expect(screen.queryByText('1 potential item found.')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Download verified redacted copy' })).toBeNull();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('renders and filters a keyboard-scrollable native detection table', async () => {
    const user = userEvent.setup();
    const jobs: LocalJobClient = {
      ...readyJobClient(),
      scan: () => Promise.resolve({
        outcome: 'SUCCEEDED', detections: 2, conflicts: 0, byEntity: { EMAIL: 1, PHONE: 1 },
        jobId: 'job_01J4M91NJK8WAPJ7J95K73CB2M', jobRevision: 6, cursor: 0, nextCursor: null,
        details: [
          { id: firstDetectionId, entityType: 'EMAIL', start: 5, end: 12, confidence: 0.99, sources: ['REGEX'] },
          { id: secondDetectionId, entityType: 'PHONE', start: 20, end: 30, confidence: 0.96, sources: ['REGEX'] }
        ],
        conflictDetails: [], conflictDetailsLimited: false,
        job: {
          id: 'job_01J4M91NJK8WAPJ7J95K73CB2M', operation: 'SCAN', state: 'SUCCEEDED', revision: 6,
          policy: { id: 'development-labels', version: '0.1.0', digest: `sha256:${'a'.repeat(64)}` },
          createdAt: '2026-08-09T12:00:00.000Z', updatedAt: '2026-08-09T12:00:01.000Z'
        },
        events: [],
        review: emptyReview
      })
    };
    render(<WebApplication capabilityClient={readyClient()} jobClient={jobs} />);
    await screen.findByText('Local engine is ready');
    await user.upload(screen.getByLabelText('Document file'), new File(['synthetic'], 'synthetic.txt'));
    await user.click(screen.getByRole('button', { name: 'Scan locally' }));
    await screen.findByText('Characters 6–12');
    expect(screen.getByText('Characters 21–30')).toBeTruthy();
    const tableRegion = screen.getByRole('region', { name: 'Detection details' });
    tableRegion.focus();
    expect(document.activeElement).toBe(tableRegion);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('Saved reviewer decisions: 0 of 2.')).toBeTruthy();
    const nextUnreviewed = screen.getByRole('button', { name: 'Next unreviewed in this view' });
    await user.click(nextUnreviewed);
    const firstReview = screen.getByLabelText('Review decision: Characters 6–12');
    expect(document.activeElement).toBe(firstReview);
    await user.selectOptions(firstReview, 'ACCEPT');
    await user.click(nextUnreviewed);
    expect(document.activeElement).toBe(screen.getByLabelText('Review decision: Characters 21–30'));
    expect(screen.getByText('1 unreviewed in this filtered page view')).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Filter detections'), 'EMAIL');
    expect(screen.getByText('Characters 6–12')).toBeTruthy();
    expect(screen.queryByText('Characters 21–30')).toBeNull();
  });

  it('saves an accessible category-change decision and enables review-bound redaction', async () => {
    const user = userEvent.setup();
    const appendReviewDecisions = vi.fn<LocalJobClient['appendReviewDecisions']>(
      (jobId, jobRevision, expectedExtractionRevision, _reviewRevision, decisions) => {
        const decision = decisions[0];
        if (decision === undefined) return Promise.reject(new Error('Review decision missing'));
        return Promise.resolve({
        schemaVersion: '1.0.0',
        jobId,
        jobRevision,
        extractionRevision: expectedExtractionRevision,
        reviewRevision: 1,
        digest: `sha256:${'f'.repeat(64)}`,
        decisions: [{
          ...decision, revision: 1, principal: 'LOCAL_SESSION',
          occurredAt: '2026-08-09T12:00:02.000Z'
        }]
      });
      }
    );
    const jobs: LocalJobClient = { ...readyJobClient(), appendReviewDecisions };
    const { container } = render(<WebApplication capabilityClient={readyClient()} jobClient={jobs} />);
    await screen.findByText('Local engine is ready');
    await user.upload(screen.getByLabelText('Document file'), new File(['synthetic'], 'synthetic.txt'));
    await user.click(screen.getByRole('button', { name: 'Scan locally' }));
    await screen.findByText('Characters 20–46');

    await user.selectOptions(screen.getByLabelText('Review decision: Characters 20–46'), 'RETYPE');
    const category = screen.getByLabelText('New category: Characters 20–46');
    expect([...category.querySelectorAll('option')].map(({ textContent }) => textContent)).toEqual([
      'Email addresses', 'Phone numbers', 'Social Security numbers', 'Payment cards'
    ]);
    await user.selectOptions(category, 'PHONE');
    await user.click(screen.getByRole('button', { name: 'Save review decisions' }));

    expect(await screen.findByText(
      'Review decisions were saved to the process-local append-only history.'
    )).toBeTruthy();
    expect(appendReviewDecisions).toHaveBeenCalledWith(
      scanJobId,
      6,
      extractionRevision,
      0,
      [expect.objectContaining({
        targetDetectionId: firstDetectionId,
        action: 'RETYPE',
        entityType: 'PHONE',
        reasonCode: 'INCORRECT_ENTITY_TYPE'
      })],
      expect.any(AbortSignal)
    );
    expect(screen.getByText(/Saved review decisions will be bound into the exact redaction plan/u)).toBeTruthy();
    expect(screen.getByText('Saved reviewer decisions: 1 of 1.')).toBeTruthy();
    expect(screen.getByText('Every detection has a saved reviewer decision.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Redact and preview' })).toBeTruthy();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('reports an optimistic review conflict without overwriting the local draft', async () => {
    const user = userEvent.setup();
    const jobs: LocalJobClient = {
      ...readyJobClient(),
      appendReviewDecisions: () => Promise.reject(new Error('REVIEW_REVISION_CONFLICT'))
    };
    render(<WebApplication capabilityClient={readyClient()} jobClient={jobs} />);
    await screen.findByText('Local engine is ready');
    await user.upload(screen.getByLabelText('Document file'), new File(['synthetic'], 'synthetic.txt'));
    await user.click(screen.getByRole('button', { name: 'Scan locally' }));
    await screen.findByText('Characters 20–46');
    await user.selectOptions(screen.getByLabelText('Review decision: Characters 20–46'), 'REJECT');
    await user.click(screen.getByRole('button', { name: 'Save review decisions' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'This review changed in another request. Rescan the document before reconciling or saving more decisions.'
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Review decision: Characters 20–46').value).toBe('REJECT');
  });

  it('keeps the table and uses server-owned pages when more results are available', async () => {
    const user = userEvent.setup();
    const base = readyJobClient();
    const first = await base.scan(
      new File(['synthetic'], 'synthetic.txt'),
      (await base.loadPolicies(new AbortController().signal)).defaultPolicy,
      () => undefined,
      new AbortController().signal
    );
    const jobs: LocalJobClient = {
      ...base,
      scan: () => Promise.resolve({
        ...first,
        detections: 2,
        byEntity: { EMAIL: 1, PHONE: 1 },
        nextCursor: 1
      }),
      listDetections: (_jobId, cursor) => Promise.resolve(cursor === 0
        ? { ...first, detections: 2, byEntity: { EMAIL: 1, PHONE: 1 }, nextCursor: 1 }
        : {
          ...first,
          detections: 2,
          byEntity: { EMAIL: 1, PHONE: 1 },
          cursor,
          nextCursor: null,
          details: [{ id: secondDetectionId, entityType: 'PHONE', start: 50, end: 60, confidence: 0.96, sources: ['REGEX'] }]
        })
    };
    render(<WebApplication capabilityClient={readyClient()} jobClient={jobs} />);
    await screen.findByText('Local engine is ready');
    await user.upload(screen.getByLabelText('Document file'), new File(['synthetic'], 'synthetic.txt'));
    await user.click(screen.getByRole('button', { name: 'Scan locally' }));

    expect(await screen.findByText('Showing 1–1 of 2')).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    const nextPage = screen.getByRole<HTMLButtonElement>('button', { name: 'Next page' });
    await user.selectOptions(screen.getByLabelText('Review decision: Characters 20–46'), 'ACCEPT');
    expect(nextPage.disabled).toBe(true);
    expect(screen.getByText('Save or discard unsaved review decisions before changing pages.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Discard unsaved decisions' }));
    expect(nextPage.disabled).toBe(false);
    await user.click(nextPage);
    expect(await screen.findByText('Characters 51–60')).toBeTruthy();
    expect(screen.getByText('Showing 2–2 of 2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('Characters 20–46')).toBeTruthy();
  });

  it('renders conflict locations and evidence without returning the planted value', async () => {
    const user = userEvent.setup();
    const plantedValue = '+378282246310005';
    const jobs: LocalJobClient = {
      ...readyJobClient(),
      scan: () => Promise.resolve({
        outcome: 'NEEDS_REVIEW', detections: 1, conflicts: 1, byEntity: { PHONE: 1 },
        jobId: 'job_01J4M91NJK8WAPJ7J95K73CB2M', jobRevision: 6, cursor: 0, nextCursor: null,
        details: [{ id: firstDetectionId, entityType: 'PHONE', start: 29, end: 45, confidence: 0.86, sources: ['REGEX'] }],
        conflictDetails: [{
          code: 'INCOMPATIBLE_OVERLAP', start: 29, end: 45,
          entityTypes: ['CREDIT_CARD', 'PHONE'], sources: ['CHECKSUM', 'REGEX']
        }],
        conflictDetailsLimited: false,
        job: {
          id: 'job_01J4M91NJK8WAPJ7J95K73CB2M', operation: 'SCAN', state: 'NEEDS_REVIEW', revision: 6,
          policy: { id: 'development-labels', version: '0.1.0', digest: `sha256:${'a'.repeat(64)}` },
          createdAt: '2026-08-09T12:00:00.000Z', updatedAt: '2026-08-09T12:00:01.000Z'
        },
        events: [],
        review: emptyReview
      })
    };
    const { container } = render(<WebApplication capabilityClient={readyClient()} jobClient={jobs} />);
    await screen.findByText('Local engine is ready');
    await user.upload(
      screen.getByLabelText('Document file'),
      new File([`Synthetic card-like contact: ${plantedValue}`], 'synthetic.txt')
    );
    await user.click(screen.getByRole('button', { name: 'Scan locally' }));

    expect(await screen.findByRole('heading', { level: 3, name: 'Conflicts requiring review' })).toBeTruthy();
    expect(screen.getByText('No automatic decision was made for these overlapping detections.')).toBeTruthy();
    expect(screen.getByText('Overlapping characters 30–45')).toBeTruthy();
    expect(screen.getByText('Possible categories: Payment cards and Phone numbers')).toBeTruthy();
    expect(screen.getByText('Conflicting evidence: checksum and pattern rule')).toBeTruthy();
    expect(container.textContent).not.toContain(plantedValue);
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('rejects unsupported and oversized selections using privacy-safe local messages', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<WebApplication capabilityClient={readyClient()} jobClient={readyJobClient()} />);
    await screen.findByText('Local engine is ready');
    const input = screen.getByLabelText('Document file');

    await user.upload(input, new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' }));
    expect(screen.getByRole('alert').textContent).toContain('supported extensions');

    const oversized = new File(['synthetic'], 'synthetic.txt', { type: 'text/plain' });
    Object.defineProperty(oversized, 'size', { value: 8_388_609 });
    await user.upload(input, oversized);
    expect(screen.getByRole('alert').textContent).toContain('8 MiB');
  });

  it('keeps stress locales test-only while preserving canonical capability values', async () => {
    render(<WebApplication capabilityClient={readyClient()} jobClient={readyJobClient()} initialLocale="ar-XB" />);
    await waitFor(() => { expect(screen.getAllByText(/٨/u).length).toBeGreaterThan(0); });

    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar-XB');
    expect(document.title).toContain('PII');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('uses the selected extension-specific limit without reading file bytes', () => {
    expect(preflightSelectedFile(
      { name: 'synthetic.md', size: 11 },
      { supportedFiles: [{ extension: '.md', maximumInputBytes: 10, supportsRedaction: true }] }
    )).toEqual({ kind: 'too-large', maximumInputBytes: 10 });
    expect(preflightSelectedFile(
      { name: 'synthetic.TXT', size: 10 },
      { supportedFiles: [{ extension: '.txt', maximumInputBytes: 10, supportsRedaction: true }] }
    )).toEqual({ kind: 'ready', byteLength: 10, extension: '.txt' });
  });

  it('reports a missing launcher session without inventing a processing workflow', async () => {
    const disconnected: CapabilityClient = {
      load: () => Promise.reject(new Error('LOCAL_SESSION_MISSING'))
    };
    const disconnectedJobs: LocalJobClient = {
      ...readyJobClient(),
      loadPolicies: () => Promise.reject(new Error('LOCAL_SESSION_MISSING'))
    };
    render(<WebApplication capabilityClient={disconnected} jobClient={disconnectedJobs} />);
    expect(await screen.findByText('Local API session is not connected')).toBeTruthy();
    expect(screen.queryByLabelText('Document file')).toBeNull();
    expect(screen.getByText('Connect to the local engine before choosing a document.')).toBeTruthy();
  });
});
