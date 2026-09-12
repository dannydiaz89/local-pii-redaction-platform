// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent, type UserEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { message } from '@local-pii/i18n';

import { WebApplication } from '../src/application.js';
import type {
  CapabilityClient,
  JobDetectionSummary,
  LocalJobClient,
  ProcessingScanSummary,
  ScanProgressState
} from '@local-pii/sdk';

/**
 * Automated half of the accessible review journey evidence. These tests drive the real review
 * workflow through the accessibility tree only: roles, accessible names, live regions, and the
 * keyboard. They deliberately never query by class name or test id.
 *
 * jsdom limits that the assertions below respect rather than paper over:
 *   - jsdom performs no layout, so reflow, zoom, target size, and colour contrast cannot be
 *     measured here. `colour contrast is not decidable in jsdom` records that honestly instead of
 *     asserting a pass; `browser zoom` checks the only zoom-related fact a DOM can carry.
 *   - jsdom does not implement native `select` keyboard interaction (arrow keys and type-ahead do
 *     not change the value) nor `summary` activation via Enter or Space. Those controls are
 *     therefore asserted to be tab-reachable and focusable, and their values are changed through
 *     `userEvent.selectOptions`/`click`. Only a real browser can prove the operation itself.
 *   - jsdom does not move focus to the body when the focused element merely becomes `disabled`,
 *     the way browsers do. Focus loss is therefore only provable here when the focused element is
 *     unmounted.
 */

const scanJobId = 'job_01J4M91NJK8WAPJ7J95K73CB2M';
const firstDetectionId = '123e4567-e89b-42d3-a456-426614174011';
const secondDetectionId = '123e4567-e89b-42d3-a456-426614174012';
const extractionRevision = `sha256:${'d'.repeat(64)}`;
/** Planted document value. It must never reach an announcement, a status, or an error. */
const documentCanary = 'review-canary@example.test';
const documentText = `Synthetic contact: ${documentCanary} and phone 555-0100`;
const firstLocation = 'Characters 20–45';
const secondLocation = 'Characters 57–64';
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
        { extension: '.md', maximumInputBytes: 104_857_600, supportsRedaction: true },
        { extension: '.txt', maximumInputBytes: 104_857_600, supportsRedaction: true }
      ],
      supportedEntityTypes: ['EMAIL', 'PHONE', 'SSN', 'CREDIT_CARD']
    })
  };
}

const completedJob = {
  id: scanJobId,
  operation: 'SCAN' as const,
  state: 'SUCCEEDED' as const,
  revision: 6,
  policy: { id: 'development-labels', version: '0.1.0', digest: `sha256:${'a'.repeat(64)}` },
  createdAt: '2026-08-09T12:00:00.000Z',
  updatedAt: '2026-08-09T12:00:01.000Z'
};
const firstDetection: JobDetectionSummary = {
  id: firstDetectionId, entityType: 'EMAIL', start: 19, end: 45, confidence: 0.99, sources: ['REGEX']
};
const secondDetection: JobDetectionSummary = {
  id: secondDetectionId, entityType: 'PHONE', start: 56, end: 64, confidence: 0.96, sources: ['REGEX']
};

/** A populated first page of two findings with a second server-owned page still available. */
function scanSummary(): ProcessingScanSummary {
  return {
    outcome: 'SUCCEEDED',
    jobId: scanJobId,
    jobRevision: 6,
    detections: 3,
    conflicts: 0,
    byEntity: { EMAIL: 1, PHONE: 2 },
    cursor: 0,
    nextCursor: 2,
    details: [firstDetection, secondDetection],
    conflictDetails: [],
    conflictDetailsLimited: false,
    job: completedJob,
    review: emptyReview,
    events: [
      {
        id: '123e4567-e89b-42d3-a456-426614174000', cursor: 1, revision: 1,
        type: 'JOB_CREATED', occurredAt: completedJob.createdAt
      },
      {
        id: '123e4567-e89b-42d3-a456-426614174001', cursor: 2, revision: 2,
        type: 'STATE_CHANGED', occurredAt: completedJob.updatedAt
      }
    ]
  };
}

function reviewJobClient(overrides: Partial<LocalJobClient> = {}): LocalJobClient {
  const unavailable = (): Promise<never> => Promise.reject(new Error('NOT_IMPLEMENTED'));
  const policy = {
    id: 'development-labels', version: '0.1.0', digest: `sha256:${'a'.repeat(64)}`,
    riskTier: 'LOW' as const, example: true
  };
  const redactedBytes = new TextEncoder().encode('Synthetic contact: [EMAIL_1] and phone [PHONE_1]');
  return {
    loadPolicies: () => Promise.resolve({ defaultPolicy: policy, policies: [policy] }),
    scan: () => Promise.resolve(scanSummary()),
    redact: () => Promise.resolve({
      job: { ...completedJob, operation: 'REDACT', state: 'VERIFIED', revision: 8 },
      output: {
        id: 'art_01J4M91NJK8WAPJ7J95K73CB2N',
        mediaType: 'text/plain',
        byteLength: redactedBytes.byteLength,
        digest: `sha256:${'c'.repeat(64)}`,
        displayName: 'document.redacted.txt',
        bytes: redactedBytes
      }
    }),
    listDetections: (_jobId, cursor) => Promise.resolve(cursor === 0
      ? { ...scanSummary(), cursor: 0, nextCursor: 2, details: [firstDetection, secondDetection] }
      : {
        ...scanSummary(),
        cursor,
        nextCursor: null,
        details: [{
          id: '123e4567-e89b-42d3-a456-426614174013', entityType: 'PHONE',
          start: 70, end: 78, confidence: 0.91, sources: ['REGEX']
        }]
      }),
    getReviewSet: () => Promise.resolve(emptyReview),
    appendReviewDecisions: (jobId, jobRevision, expectedExtraction, _reviewRevision, decisions) => Promise.resolve({
      ...emptyReview,
      jobId,
      jobRevision,
      extractionRevision: expectedExtraction,
      reviewRevision: decisions.length,
      decisions: decisions.map((decision, index) => ({
        ...decision, revision: index + 1, principal: 'LOCAL_SESSION' as const,
        occurredAt: '2026-08-09T12:00:02.000Z'
      }))
    }),
    scanPreview: unavailable,
    create: unavailable,
    get: unavailable,
    listEvents: unavailable,
    cancel: unavailable,
    expire: () => Promise.resolve(),
    ...overrides
  };
}

function documentFile(): File {
  return new File([documentText], 'private-reviewer-notes.txt', { type: 'text/plain' });
}

/** Drives selection and scanning, leaving the application in its populated review state. */
async function renderReviewWorkflow(
  user: UserEvent,
  jobClient: LocalJobClient = reviewJobClient()
): Promise<HTMLElement> {
  const { container } = render(<WebApplication capabilityClient={readyClient()} jobClient={jobClient} />);
  await screen.findByText('Local engine is ready');
  await user.upload(screen.getByLabelText('Document file'), documentFile());
  await user.click(screen.getByRole('button', { name: 'Scan document' }));
  await screen.findByText(firstLocation);
  return container;
}

/**
 * `details`/`summary` is the native disclosure pattern, and browsers expose the summary as the
 * focusable, expandable control named by its own text. Neither jsdom nor the ARIA element-role
 * mapping used by Testing Library models that, so the summary is located by its text and then
 * checked to really be the disclosure control of a `details` element.
 */
function disclosureToggle(name: string): HTMLElement {
  const toggle = screen.getByText(name);
  if (toggle.tagName !== 'SUMMARY' || toggle.parentElement?.tagName !== 'DETAILS') {
    throw new Error(`${name} is not a native disclosure control.`);
  }
  return toggle;
}

function activeElement(): Element {
  const active = document.activeElement;
  if (active === null) throw new Error('The document has no active element.');
  return active;
}

/** Tabs forward `steps` times and reports each landing element, using the body as the cycle mark. */
async function tabThrough(user: UserEvent, steps: number): Promise<readonly Element[]> {
  const visited: Element[] = [];
  for (let step = 0; step < steps; step += 1) {
    await user.tab();
    visited.push(activeElement());
  }
  return visited;
}

/** Every element that would be announced by a screen reader when its content changes. */
function liveRegions(): readonly Element[] {
  return [...document.querySelectorAll('[aria-live]')];
}

function axeOptions(): axe.RunOptions {
  // jsdom has no layout engine, so axe cannot evaluate colour contrast; see the dedicated test.
  return { rules: { 'color-contrast': { enabled: false } } };
}

describe('accessible review journeys', () => {
  it('traverses the whole review workflow by keyboard in document order without trapping focus', async () => {
    const user = userEvent.setup();
    render(<WebApplication capabilityClient={readyClient()} jobClient={reviewJobClient()} />);
    await screen.findByText('Local engine is ready');

    // File selection and the scan are reached and started with the keyboard alone. The file
    // picker dialog itself belongs to the browser chrome, so only its control is asserted here.
    const beforeScan = await tabThrough(user, 4);
    expect(beforeScan).toEqual([
      screen.getByRole('link', { name: 'Skip to main content' }),
      screen.getByRole('link', { name: 'Local PII' }),
      screen.getByLabelText('Document file'),
      disclosureToggle('Privacy and technical details')
    ]);

    await user.upload(screen.getByLabelText('Document file'), documentFile());
    screen.getByLabelText('Document file').focus();
    await user.tab();
    expect(activeElement()).toBe(screen.getByRole('button', { name: 'Scan document' }));
    await user.keyboard('{Enter}');
    await screen.findByText(firstLocation);
    await screen.findByText(documentCanary);

    // Every control of the populated review state, in the order a keyboard reviewer meets it.
    screen.getByRole('button', { name: 'Scan document' }).focus();
    const reviewOrder = await tabThrough(user, 10);
    expect(reviewOrder).toEqual([
      disclosureToggle('Job activity'),
      screen.getByLabelText('Filter detections'),
      screen.getByRole('region', { name: 'Detection details' }),
      screen.getAllByRole('button', { name: 'View source context' })[0],
      screen.getByLabelText(`Review decision: ${firstLocation}`),
      screen.getAllByRole('button', { name: 'View source context' })[1],
      screen.getByLabelText(`Review decision: ${secondLocation}`),
      screen.getByRole('button', { name: 'Previous unreviewed in this view' }),
      screen.getByRole('button', { name: 'Next unreviewed in this view' }),
      screen.getByRole('button', { name: 'Next page' })
    ]);
    const afterPaging = await tabThrough(user, 3);
    expect(afterPaging).toEqual([
      screen.getByRole('button', { name: 'Redact and preview' }),
      screen.getByRole('button', { name: 'Clear current workflow' }),
      disclosureToggle('Privacy and technical details')
    ]);

    // No trap: tabbing past the final control returns to the first one rather than sticking.
    const wrap = await tabThrough(user, 2);
    expect(wrap[0]).toBe(document.body);
    expect(wrap[1]).toBe(screen.getByRole('link', { name: 'Skip to main content' }));

    // Reverse traversal reaches the same controls, so no control is forward-only.
    await user.tab({ shift: true });
    expect(activeElement()).toBe(document.body);
    await user.tab({ shift: true });
    expect(activeElement()).toBe(disclosureToggle('Privacy and technical details'));
    await user.tab({ shift: true });
    expect(activeElement()).toBe(screen.getByRole('button', { name: 'Clear current workflow' }));

    // An unsaved decision swaps the page controls for the save controls; both stay reachable.
    await user.selectOptions(screen.getByLabelText(`Review decision: ${firstLocation}`), 'ACCEPT');
    screen.getByRole('button', { name: 'Next unreviewed in this view' }).focus();
    const withDraft = await tabThrough(user, 3);
    expect(withDraft).toEqual([
      screen.getByRole('button', { name: 'Discard unsaved decisions' }),
      screen.getByRole('button', { name: 'Save review decisions' }),
      // Paging and redaction are deliberately unavailable while a decision is unsaved, so a
      // keyboard reviewer skips straight past both disabled controls.
      screen.getByRole('button', { name: 'Clear current workflow' })
    ]);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next page' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Redact and preview' }).disabled).toBe(true);
  });

  it('keeps keyboard focus in the workflow every time the review view changes', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:local-a11y') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const user = userEvent.setup();
    await renderReviewWorkflow(user);

    // Results arriving must not strand the reviewer: the control they activated is still focused.
    expect(activeElement()).toBe(screen.getByRole('button', { name: 'Scan document' }));

    // Skip-links move focus by fragment; the unreviewed-navigation buttons move it by script.
    await user.click(screen.getByRole('button', { name: 'Next unreviewed in this view' }));
    expect(activeElement()).toBe(screen.getByLabelText(`Review decision: ${firstLocation}`));

    // Opening the source-context disclosure moves focus into the revealed region, and closing it
    // returns focus to the toggle rather than to the body.
    const contextToggle = screen.getAllByRole('button', { name: 'View source context' })[0];
    if (contextToggle === undefined) throw new Error('The source context toggle is unavailable.');
    await user.click(contextToggle);
    const contextRegion = await screen.findByRole('region', {
      name: 'Highlighted detected text in its local source context'
    });
    await waitFor(() => { expect(activeElement()).toBe(contextRegion); });
    await user.click(screen.getByRole('button', { name: 'Close source context' }));
    expect(activeElement()).toBe(screen.getAllByRole('button', { name: 'View source context' })[0]);

    // Discarding removes the button that was activated, so focus has to be placed deliberately.
    await user.selectOptions(screen.getByLabelText(`Review decision: ${firstLocation}`), 'ACCEPT');
    await user.click(screen.getByRole('button', { name: 'Discard unsaved decisions' }));
    expect(activeElement()).not.toBe(document.body);
    expect(activeElement()).toBe(screen.getByRole('region', { name: 'Detection details' }));

    // Saving disables the save button and removes the discard button: focus lands on the outcome.
    await user.selectOptions(screen.getByLabelText(`Review decision: ${firstLocation}`), 'ACCEPT');
    await user.click(screen.getByRole('button', { name: 'Save review decisions' }));
    await screen.findByText('Review decisions were saved to the process-local append-only history.');
    expect(activeElement()).not.toBe(document.body);
    expect(activeElement().getAttribute('role')).toBe('status');
    expect(activeElement().textContent)
      .toBe('Review decisions were saved to the process-local append-only history.');

    // Turning the page replaces the whole table body under the reviewer.
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Characters 71–78')).toBeTruthy();
    expect(activeElement()).toBe(screen.getByRole('region', { name: 'Detection details' }));
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText(firstLocation)).toBeTruthy();
    expect(activeElement()).toBe(screen.getByRole('region', { name: 'Detection details' }));

    // Redaction replaces its own trigger with the verified download.
    await user.click(screen.getByRole('button', { name: 'Redact and preview' }));
    const download = await screen.findByRole('link', { name: 'Download verified redacted copy' });
    expect(activeElement()).not.toBe(document.body);
    expect(activeElement()).toBe(download);

    // The destructive confirmation and its dismissal both replace the control that was pressed.
    await user.click(screen.getByRole('button', { name: 'Clear current workflow' }));
    expect(activeElement()).toBe(screen.getByRole('group', { name: 'Clear this document workflow now?' }));
    await user.click(screen.getByRole('button', { name: 'Keep workflow' }));
    expect(activeElement()).toBe(screen.getByRole('button', { name: 'Clear current workflow' }));

    await user.click(screen.getByRole('button', { name: 'Clear current workflow' }));
    await user.click(screen.getByRole('button', { name: 'Clear now' }));
    await screen.findByText('The current workflow was cleared from this application session.');
    expect(activeElement()).not.toBe(document.body);
    expect(activeElement().getAttribute('role')).toBe('status');
  });

  it('gives every interactive control in the populated review state an accessible name', async () => {
    const user = userEvent.setup();
    await renderReviewWorkflow(user);
    await user.selectOptions(screen.getByLabelText(`Review decision: ${firstLocation}`), 'RETYPE');
    await user.click(disclosureToggle('Privacy and technical details'));

    for (const role of ['button', 'link', 'combobox', 'progressbar', 'region'] as const) {
      const everyControl = screen.queryAllByRole(role);
      const namedControls = screen.queryAllByRole(role, { name: /\S/u });
      expect(everyControl.length).toBeGreaterThan(0);
      expect(namedControls).toEqual(everyControl);
    }

    // The names themselves have to distinguish one row's controls from another's.
    expect(screen.getByLabelText(`Review decision: ${firstLocation}`)).toBeTruthy();
    expect(screen.getByLabelText(`Review decision: ${secondLocation}`)).toBeTruthy();
    expect(screen.getByLabelText(`New category: ${firstLocation}`)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Saved reviewer decisions' })).toBeTruthy();

    // Headings describe the workflow in a single unbroken outline.
    expect(screen.getByRole('heading', { level: 1, name: 'Scan a document' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Choose a file' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Detection details' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: 'Review progress' })).toBeTruthy();
    expect(screen.getAllByRole('heading').map((heading) => Number(heading.tagName.slice(1))))
      .toEqual([1, 2, 3, 3, 4, 3, 3]);

    // The decision control is a real listbox of decisions, not an unlabelled widget.
    const decision = screen.getByLabelText<HTMLSelectElement>(`Review decision: ${firstLocation}`);
    expect([...decision.options].map((option) => option.textContent)).toEqual([
      'Not reviewed', 'Accept detection', 'Reject as false positive', 'Change category'
    ]);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent))
      .toEqual(['Finding', 'Why it was flagged', 'Review decision']);
    expect(screen.getAllByRole('rowheader').map((header) => header.getAttribute('scope')))
      .toEqual(['row', 'row']);
  });

  it('announces asynchronous progress, decisions, and verification in live regions', async () => {
    let reportProgress: ((progress: ScanProgressState) => void) | undefined;
    let completeScan: (() => void) | undefined;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:local-a11y') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const user = userEvent.setup();
    const jobClient = reviewJobClient({
      scan: (_file, _policy, onProgress) => new Promise((resolve) => {
        reportProgress = onProgress;
        completeScan = () => { resolve(scanSummary()); };
      })
    });
    render(<WebApplication capabilityClient={readyClient()} jobClient={jobClient} />);
    await screen.findByText('Local engine is ready');

    // The preflight outcome is itself announced, not only painted.
    const preflightStatus = screen.getByRole('status', { name: '' });
    expect(preflightStatus.getAttribute('aria-live')).toBe('polite');
    expect(preflightStatus.textContent).toBe('Local engine is ready');

    await user.upload(screen.getByLabelText('Document file'), documentFile());
    expect(screen.getAllByRole('status').some(
      (region) => region.textContent === 'TXT · 64 bytes · Ready to scan'
    )).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Scan document' }));
    expect(await screen.findByText('Job status: Sending to the authenticated local worker')).toBeTruthy();
    if (reportProgress === undefined) throw new Error('The scan never reported progress.');
    reportProgress('DETECTING');
    const progressRegion = await waitFor(() => {
      const region = screen.getAllByRole('status').find(
        (candidate) => candidate.textContent.includes('Detecting potential items')
      );
      if (region === undefined) throw new Error('No live region announced scan progress.');
      return region;
    });
    expect(progressRegion.getAttribute('aria-live')).toBe('polite');

    if (completeScan === undefined) throw new Error('The scan cannot be completed.');
    completeScan();
    await screen.findByText(firstLocation);
    await screen.findByText(documentCanary);

    // The scan outcome itself is announced, and only the outcome: the live region must not reach
    // over the detection review, whose rows carry detected document text and re-render constantly.
    const outcomeRegion = await waitFor(() => {
      const region = screen.getAllByRole('status').find(
        (candidate) => candidate.textContent.includes('3 potential items found.')
      );
      if (region === undefined) throw new Error('No live region announced the scan outcome.');
      return region;
    });
    expect(outcomeRegion.getAttribute('aria-live')).toBe('polite');
    expect(outcomeRegion.textContent)
      .toBe('Scan complete2 server events recorded for this scan.3 potential items found.');
    for (const region of liveRegions()) {
      expect(region.querySelector('table')).toBeNull();
      expect(region.querySelector('code')).toBeNull();
    }

    await user.selectOptions(screen.getByLabelText(`Review decision: ${firstLocation}`), 'ACCEPT');
    expect(screen.getAllByRole('status').some(
      (region) => region.textContent === 'Unsaved review decisions are selected.'
    )).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save review decisions' }));
    const savedRegion = await waitFor(() => {
      const region = screen.getAllByRole('status').find(
        (candidate) => candidate.textContent
          === 'Review decisions were saved to the process-local append-only history.'
      );
      if (region === undefined) throw new Error('No live region announced the saved decision.');
      return region;
    });
    expect(savedRegion.getAttribute('aria-live')).toBe('polite');

    await user.click(screen.getByRole('button', { name: 'Redact and preview' }));
    const verifiedRegion = await waitFor(() => {
      const region = screen.getAllByRole('status').find(
        (candidate) => candidate.textContent.startsWith('The redacted copy passed verification.')
      );
      if (region === undefined) throw new Error('No live region announced the verification outcome.');
      return region;
    });
    expect(verifiedRegion.getAttribute('aria-live')).toBe('polite');

    // Nothing a screen reader is told may carry the document value or the file name.
    const announced = liveRegions().map((region) => region.textContent);
    expect(announced.length).toBeGreaterThan(3);
    for (const announcement of announced) {
      expect(announcement).not.toContain(documentCanary);
      expect(announcement).not.toContain('555-0100');
      expect(announcement).not.toContain('private-reviewer-notes');
    }
  });

  it('announces asynchronous failures assertively without quoting the failure detail', async () => {
    const user = userEvent.setup();
    const jobClient = reviewJobClient({
      scan: () => Promise.reject(new Error(`/private/tmp/${documentCanary}`))
    });
    render(<WebApplication capabilityClient={readyClient()} jobClient={jobClient} />);
    await screen.findByText('Local engine is ready');
    await user.upload(screen.getByLabelText('Document file'), documentFile());
    await user.click(screen.getByRole('button', { name: 'Scan document' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The local preview scan could not be completed.');
    expect(alert.getAttribute('aria-live')).toBe('polite');
    for (const announcement of liveRegions().map((region) => region.textContent)) {
      expect(announcement).not.toContain(documentCanary);
      expect(announcement).not.toContain('/private/tmp');
    }
  });

  it('announces a failed workflow clearance instead of silently leaving the document staged', async () => {
    const user = userEvent.setup();
    const jobClient = reviewJobClient({ expire: () => Promise.reject(new Error('LOCAL_SESSION_MISSING')) });
    await renderReviewWorkflow(user, jobClient);
    await user.click(screen.getByRole('button', { name: 'Clear current workflow' }));
    await user.click(screen.getByRole('button', { name: 'Clear now' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent)
      .toBe('The workflow could not be fully cleared. It remains on this page so you can try again.');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    expect(activeElement()).toBe(screen.getByRole('button', { name: 'Clear current workflow' }));
  });

  it('finds no axe violations in the populated review, retype, and verified output states', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:local-a11y') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const user = userEvent.setup();
    const container = await renderReviewWorkflow(user);
    await screen.findByText(documentCanary);

    // State 1: two findings, paging controls, review progress, and both disclosures expanded.
    await user.click(disclosureToggle('Job activity'));
    await user.click(disclosureToggle('Privacy and technical details'));
    expect((await axe.run(container, axeOptions())).violations).toEqual([]);

    // State 2: a retype decision open, with its extra category control, plus source context shown.
    await user.selectOptions(screen.getByLabelText(`Review decision: ${firstLocation}`), 'RETYPE');
    const contextToggle = screen.getAllByRole('button', { name: 'View source context' })[1];
    if (contextToggle === undefined) throw new Error('The source context toggle is unavailable.');
    await user.click(contextToggle);
    await screen.findByRole('region', { name: 'Highlighted detected text in its local source context' });
    expect((await axe.run(container, axeOptions())).violations).toEqual([]);

    // State 3: decisions saved, so the saved-status live region and bound-redaction callout render.
    await user.click(screen.getByRole('button', { name: 'Save review decisions' }));
    await screen.findByText('Review decisions were saved to the process-local append-only history.');
    expect((await axe.run(container, axeOptions())).violations).toEqual([]);

    // State 4: verified redacted output, preview region, and download link.
    await user.click(screen.getByRole('button', { name: 'Redact and preview' }));
    await screen.findByRole('link', { name: 'Download verified redacted copy' });
    expect(screen.getByRole('region', { name: 'Verified redacted output preview' })).toBeTruthy();
    expect((await axe.run(container, axeOptions())).violations).toEqual([]);

    // State 5: the destructive confirmation group.
    await user.click(screen.getByRole('button', { name: 'Clear current workflow' }));
    expect(screen.getByRole('group', { name: 'Clear this document workflow now?' })).toBeTruthy();
    expect((await axe.run(container, axeOptions())).violations).toEqual([]);
  });

  it('finds no axe violations in the populated review state under a right-to-left locale', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WebApplication capabilityClient={readyClient()} jobClient={reviewJobClient()} initialLocale="ar-XB" />
    );
    await waitFor(() => { expect(screen.getAllByText(/٨/u).length).toBeGreaterThan(0); });
    // The stress locale reorders and wraps every string, so the control names come from the
    // catalog rather than from English literals: a hard-coded string here would not be found.
    await user.upload(screen.getByLabelText(message('ar-XB', 'intake.label')), documentFile());
    await user.click(screen.getByRole('button', { name: message('ar-XB', 'preview.scan') }));
    await screen.findByRole('table');
    expect(screen.getByRole('region', { name: message('ar-XB', 'preview.details') })).toBeTruthy();

    expect(document.documentElement.dir).toBe('rtl');
    expect(container.querySelectorAll('[dir="auto"]').length).toBeGreaterThan(0);
    expect((await axe.run(container, axeOptions())).violations).toEqual([]);
  });

  it('leaves browser zoom and reflow to the user agent rather than locking the viewport', async () => {
    // The jsdom environment serves `import.meta.url` over http, so the shell is read from the
    // repository root that Vitest runs in.
    const shell = await readFile(resolve(process.cwd(), 'apps/web/index.html'), 'utf8');
    const viewport = /<meta\s+name="viewport"\s+content="([^"]*)"/u.exec(shell)?.[1];

    // WCAG 1.4.4 Resize Text: the shell must not cap or disable pinch zoom.
    expect(viewport).toBe('width=device-width, initial-scale=1.0');
    expect(shell).not.toContain('user-scalable');
    expect(shell).not.toContain('maximum-scale');
  });

  it('cannot decide colour contrast or reflow in jsdom, and records that rather than claiming a pass', async () => {
    const user = userEvent.setup();
    const container = await renderReviewWorkflow(user);

    const results = await axe.run(container, { runOnly: { type: 'rule', values: ['color-contrast'] } });
    // jsdom reports every colour-contrast check as incomplete because it computes no layout and no
    // used colour values. Contrast and reflow at 200% zoom and 320 CSS pixels therefore remain
    // manual review items; this assertion exists so the gap cannot be mistaken for coverage.
    expect(results.violations).toEqual([]);
    expect(results.passes).toEqual([]);
    expect(results.incomplete.map((result) => result.id)).toEqual(['color-contrast']);
    expect(container.getBoundingClientRect().width).toBe(0);
  });
});
