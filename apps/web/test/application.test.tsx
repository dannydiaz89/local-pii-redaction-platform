// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

import { WebApplication } from '../src/application.js';
import type { CapabilityClient } from '../src/api.js';

afterEach(() => { cleanup(); });

function readyClient(): CapabilityClient {
  return {
    load: () => Promise.resolve({
      engineMode: 'RULES_ONLY',
      formatCount: 2,
      availableDetectorCount: 1,
      maximumInputBytes: 104_857_600
    })
  };
}

describe('web application foundation', () => {
  it('renders the capability preflight as an accessible local-first journey', async () => {
    const { container } = render(<WebApplication capabilityClient={readyClient()} />);

    expect(await screen.findByText('Local engine is ready')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Your document stays under your control.' })).toBeTruthy();
    expect(screen.getByText('100 MiB')).toBeTruthy();
    expect(screen.getByText('Coming in the next application slice')).toBeTruthy();
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('switches expansion and RTL stress locales without changing canonical capability values', async () => {
    const user = userEvent.setup();
    render(<WebApplication capabilityClient={readyClient()} />);
    await screen.findByText('Local engine is ready');

    await user.selectOptions(screen.getByLabelText('Interface language'), 'ar-XB');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar-XB');
    expect(document.title).toContain('PII');
    expect(screen.getByText(/١٠٠/u)).toBeTruthy();
  });

  it('reports a missing launcher session without inventing a processing workflow', async () => {
    const disconnected: CapabilityClient = {
      load: () => Promise.reject(new Error('LOCAL_SESSION_MISSING'))
    };
    render(<WebApplication capabilityClient={disconnected} />);
    expect(await screen.findByText('Local API session is not connected')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose a document' })).toBeNull();
  });
});
