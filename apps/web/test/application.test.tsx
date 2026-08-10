// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

import { WebApplication } from '../src/application.js';
import type { CapabilityClient } from '../src/api.js';
import { preflightSelectedFile } from '../src/file-preflight.js';
import type { LocalJobClient } from '../src/job-api.js';

afterEach(() => { cleanup(); });

function readyClient(): CapabilityClient {
  return {
    load: () => Promise.resolve({
      engineMode: 'RULES_ONLY',
      formatCount: 2,
      availableDetectorCount: 1,
      maximumInputBytes: 104_857_600,
      supportedFiles: [
        { extension: '.markdown', maximumInputBytes: 104_857_600 },
        { extension: '.md', maximumInputBytes: 104_857_600 },
        { extension: '.txt', maximumInputBytes: 104_857_600 }
      ]
    })
  };
}

function readyJobClient(): LocalJobClient {
  const unavailable = (): Promise<never> => Promise.reject(new Error('NOT_IMPLEMENTED'));
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
    scanPreview: () => Promise.resolve({
      outcome: 'SUCCEEDED', detections: 1, conflicts: 0, byEntity: { EMAIL: 1 },
      details: [{ entityType: 'EMAIL', start: 19, end: 46, confidence: 0.99, sources: ['REGEX'] }],
      detailsLimited: false, conflictDetails: [], conflictDetailsLimited: false
    }),
    create: unavailable,
    get: unavailable,
    listEvents: unavailable,
    cancel: unavailable
  };
}

describe('web application foundation', () => {
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
    expect(screen.getByText(/not kept in browser persistence/u)).toBeTruthy();
  });

  it('runs an ephemeral local scan and renders only minimized localized counts', async () => {
    const user = userEvent.setup();
    const { container } = render(<WebApplication capabilityClient={readyClient()} jobClient={readyJobClient()} />);
    await screen.findByText('Local engine is ready');
    const selected = new File(['Synthetic contact: preview-canary@example.test'], 'private-source.txt', {
      type: 'text/plain'
    });

    await user.upload(screen.getByLabelText('Document file'), selected);
    await user.click(screen.getByRole('button', { name: 'Scan locally' }));

    expect(await screen.findByText('1 potential item found.')).toBeTruthy();
    expect(screen.getAllByText('Email addresses').length).toBeGreaterThan(1);
    expect(screen.getByRole('heading', { level: 3, name: 'Detection details' })).toBeTruthy();
    expect(screen.getByLabelText('Filter detections')).toBeTruthy();
    expect(screen.getByText('Characters 20–46')).toBeTruthy();
    expect(screen.getByText('Detector confidence: 99%')).toBeTruthy();
    expect(screen.getByText('Evidence source: pattern rule')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Category' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Location' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Confidence' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Evidence sources' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Previous detection' })).toBeNull();
    expect(screen.queryByText('preview-canary@example.test')).toBeNull();
    expect(screen.queryByText('private-source.txt')).toBeNull();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('renders and filters a keyboard-scrollable native detection table', async () => {
    const user = userEvent.setup();
    const jobs: LocalJobClient = {
      ...readyJobClient(),
      scanPreview: () => Promise.resolve({
        outcome: 'SUCCEEDED', detections: 2, conflicts: 0, byEntity: { EMAIL: 1, PHONE: 1 },
        details: [
          { entityType: 'EMAIL', start: 5, end: 12, confidence: 0.99, sources: ['REGEX'] },
          { entityType: 'PHONE', start: 20, end: 30, confidence: 0.96, sources: ['REGEX'] }
        ],
        detailsLimited: false, conflictDetails: [], conflictDetailsLimited: false
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

    await user.selectOptions(screen.getByLabelText('Filter detections'), 'EMAIL');
    expect(screen.getByText('Characters 6–12')).toBeTruthy();
    expect(screen.queryByText('Characters 21–30')).toBeNull();
  });

  it('renders conflict locations and evidence without returning the planted value', async () => {
    const user = userEvent.setup();
    const plantedValue = '+378282246310005';
    const jobs: LocalJobClient = {
      ...readyJobClient(),
      scanPreview: () => Promise.resolve({
        outcome: 'NEEDS_REVIEW', detections: 1, conflicts: 1, byEntity: { PHONE: 1 },
        details: [{ entityType: 'PHONE', start: 29, end: 45, confidence: 0.86, sources: ['REGEX'] }],
        detailsLimited: false,
        conflictDetails: [{
          code: 'INCOMPATIBLE_OVERLAP', start: 29, end: 45,
          entityTypes: ['CREDIT_CARD', 'PHONE'], sources: ['CHECKSUM', 'REGEX']
        }],
        conflictDetailsLimited: false
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
      { supportedFiles: [{ extension: '.md', maximumInputBytes: 10 }] }
    )).toEqual({ kind: 'too-large', maximumInputBytes: 10 });
    expect(preflightSelectedFile(
      { name: 'synthetic.TXT', size: 10 },
      { supportedFiles: [{ extension: '.txt', maximumInputBytes: 10 }] }
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
