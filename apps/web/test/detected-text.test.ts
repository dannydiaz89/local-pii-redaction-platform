// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { readDetectedText } from '../src/detected-text.js';
import type { JobDetectionSummary } from '../src/job-api.js';

function detection(id: string, start: number, end: number): JobDetectionSummary {
  return { id, start, end, entityType: 'CUSTOM', confidence: 0.5, sources: ['REGEX'] };
}

describe('local detected-text disclosure', () => {
  it('uses Unicode code-point boundaries for astral, combining, zero-width, and RTL text', async () => {
    const source = '😀 A\u0301 x\u200Dy مرحبا';
    const results = await readDetectedText(
      new File([source], 'not-retained.txt'),
      [
        detection('astral', 0, 1),
        detection('combining', 2, 4),
        detection('zero-width', 5, 8),
        detection('rtl', 9, 14)
      ],
      new AbortController().signal
    );

    expect([...results]).toEqual([
      ['astral', '😀'],
      ['combining', 'A\u0301'],
      ['zero-width', 'x\u200Dy'],
      ['rtl', 'مرحبا']
    ]);
  });

  it('fails closed for invalid ranges, invalid UTF-8, and cancellation', async () => {
    await expect(readDetectedText(
      new File(['short'], 'not-retained.txt'),
      [detection('invalid', 0, 257)],
      new AbortController().signal
    )).rejects.toThrow('DETECTED_TEXT_UNAVAILABLE');
    await expect(readDetectedText(
      new File([new Uint8Array([0xc3, 0x28])], 'not-retained.txt'),
      [detection('invalid-utf8', 0, 1)],
      new AbortController().signal
    )).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(readDetectedText(
      new File(['synthetic'], 'not-retained.txt'),
      [detection('cancelled', 0, 1)],
      controller.signal
    )).rejects.toThrow('DETECTED_TEXT_ABORTED');
  });
});
