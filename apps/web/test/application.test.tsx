// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

import { WebApplication } from '../src/application.js';
import type { CapabilityClient } from '../src/api.js';
import { preflightSelectedFile } from '../src/file-preflight.js';

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

describe('web application foundation', () => {
  it('renders the capability preflight as an accessible local-first journey', async () => {
    const { container } = render(<WebApplication capabilityClient={readyClient()} />);

    expect(await screen.findByText('Local engine is ready')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Your document stays under your control.' })).toBeTruthy();
    expect(screen.getByText('100 MiB')).toBeTruthy();
    expect(screen.getByLabelText('Document file')).toBeTruthy();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('checks only selected file metadata without copying its name into application status', async () => {
    const user = userEvent.setup();
    render(<WebApplication capabilityClient={readyClient()} />);
    await screen.findByText('Local engine is ready');
    const input = screen.getByLabelText('Document file');
    const selected = new File([new Uint8Array(1024)], 'private-customer-record.md', { type: 'text/markdown' });

    await user.upload(input, selected);

    expect(screen.getByText('MD file, 1 KiB, passes the local preflight checks.')).toBeTruthy();
    expect(screen.queryByText('private-customer-record.md')).toBeNull();
    expect(screen.getByText(/stores no selection in browser persistence/u)).toBeTruthy();
  });

  it('rejects unsupported and oversized selections using privacy-safe local messages', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<WebApplication capabilityClient={readyClient()} />);
    await screen.findByText('Local engine is ready');
    const input = screen.getByLabelText('Document file');

    await user.upload(input, new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' }));
    expect(screen.getByRole('alert').textContent).toContain('supported extensions');

    const oversized = new File(['synthetic'], 'synthetic.txt', { type: 'text/plain' });
    Object.defineProperty(oversized, 'size', { value: 104_857_601 });
    await user.upload(input, oversized);
    expect(screen.getByRole('alert').textContent).toContain('100 MiB');
  });

  it('switches expansion and RTL stress locales without changing canonical capability values', async () => {
    const user = userEvent.setup();
    render(<WebApplication capabilityClient={readyClient()} />);
    await screen.findByText('Local engine is ready');

    await user.selectOptions(screen.getByLabelText('Interface language'), 'ar-XB');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar-XB');
    expect(document.title).toContain('PII');
    expect(screen.getAllByText(/١٠٠/u).length).toBeGreaterThan(0);
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
    render(<WebApplication capabilityClient={disconnected} />);
    expect(await screen.findByText('Local API session is not connected')).toBeTruthy();
    expect(screen.queryByLabelText('Document file')).toBeNull();
    expect(screen.getByText('Connect to the local engine before choosing a document.')).toBeTruthy();
  });
});
