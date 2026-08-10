// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import type { JobDetectionSummary } from '../src/job-api.js';
import { readSourceDetectionContext } from '../src/source-context.js';

function detection(start: number, end: number): JobDetectionSummary {
  return {
    id: '123e4567-e89b-42d3-a456-426614174011',
    start,
    end,
    entityType: 'EMAIL',
    confidence: 0.99,
    sources: ['REGEX']
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

describe('bounded local source context', () => {
  it('preserves Unicode code-point offsets and bounds both sides of the selected match', async () => {
    const prefix = `${'a'.repeat(90)}😀 A\u0301 `;
    const match = 'local@example.test';
    const suffix = ` مرحبا ${'z'.repeat(130)}`;
    const source = `${prefix}${match}${suffix}`;
    const start = codePointLength(prefix);
    const context = await readSourceDetectionContext(
      new File([source], 'not-retained.txt'),
      detection(start, start + codePointLength(match)),
      new AbortController().signal
    );

    expect(context.match).toBe(match);
    expect(codePointLength(context.before)).toBe(80);
    expect(codePointLength(context.after)).toBe(120);
    expect(context.leadingTruncated).toBe(true);
    expect(context.trailingTruncated).toBe(true);
    expect(`${context.before}${context.match}${context.after}`).not.toBe(source);
  });

  it('fails closed for invalid ranges, invalid UTF-8, and cancellation', async () => {
    await expect(readSourceDetectionContext(
      new File(['short'], 'not-retained.txt'),
      detection(0, 257),
      new AbortController().signal
    )).rejects.toThrow('SOURCE_CONTEXT_UNAVAILABLE');
    await expect(readSourceDetectionContext(
      new File([new Uint8Array([0xc3, 0x28])], 'not-retained.txt'),
      detection(0, 1),
      new AbortController().signal
    )).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(readSourceDetectionContext(
      new File(['synthetic'], 'not-retained.txt'),
      detection(0, 1),
      controller.signal
    )).rejects.toThrow('SOURCE_CONTEXT_ABORTED');
  });
});
