// @vitest-environment jsdom

import { render } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';

import { Button, Callout, Card, FileField, Metric, SelectField, StatusBadge } from '../src/index.js';

describe('design-system primitives', () => {
  it('compose from native controls and semantic content without accessibility violations', async () => {
    const { container, getByRole, getByLabelText } = render(
      <main>
        <h1>System check</h1>
        <Card aria-labelledby="summary-title">
          <h2 id="summary-title">Summary</h2>
          <StatusBadge tone="positive">Available</StatusBadge>
          <dl><Metric label="Formats" value="2" /></dl>
          <Callout><p>No document selected.</p></Callout>
          <SelectField id="locale" label="Language" value="en" onChange={vi.fn()}>
            <option value="en">English</option>
          </SelectField>
          <FileField id="document" label="Document" hint="TXT files only" accept=".txt" onChange={vi.fn()} />
          <Button>Retry</Button>
          <Button tone="critical">Delete</Button>
        </Card>
      </main>
    );

    expect(getByRole('button', { name: 'Retry' }).getAttribute('type')).toBe('button');
    expect(getByRole('button', { name: 'Delete' }).getAttribute('data-tone')).toBe('critical');
    expect(getByLabelText('Language').tagName).toBe('SELECT');
    expect(getByLabelText('Document').getAttribute('type')).toBe('file');
    expect(getByLabelText('Document').getAttribute('aria-describedby')).toBe('document-hint');
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });
});
