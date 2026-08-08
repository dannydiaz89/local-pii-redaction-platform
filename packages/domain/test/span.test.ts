import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertValidSpan, parseSha256Digest, sliceByCodePoint, unicodeCodePointLength, type UnicodeSpan } from '../src/index.js';

const revision = parseSha256Digest(`sha256:${'a'.repeat(64)}`);

interface OffsetVectorCorpus {
  readonly cases: readonly {
    readonly id: string;
    readonly text: string;
    readonly codePointLength: number;
    readonly slices: readonly { readonly start: number; readonly end: number; readonly expected: string }[];
  }[];
}

describe('Unicode code-point spans', () => {
  it('counts astral characters as one code point rather than two UTF-16 units', () => {
    expect(unicodeCodePointLength('A😀B')).toBe(3);
    const span: UnicodeSpan = { start: 1, end: 2, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: revision };
    expect(sliceByCodePoint('A😀B', span)).toBe('😀');
  });

  it('preserves combining marks as distinct code points', () => {
    expect(unicodeCodePointLength('é')).toBe(2);
    const span: UnicodeSpan = { start: 0, end: 2, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: revision };
    expect(sliceByCodePoint('é', span)).toBe('é');
  });

  it('uses logical code-point order for right-to-left text', () => {
    const text = 'A😀é אבגZ';
    expect(unicodeCodePointLength(text)).toBe(9);

    const combiningSpan: UnicodeSpan = { start: 2, end: 4, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: revision };
    const rtlSpan: UnicodeSpan = { start: 5, end: 8, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: revision };
    expect(sliceByCodePoint(text, combiningSpan)).toBe('é');
    expect(sliceByCodePoint(text, rtlSpan)).toBe('אבג');
  });

  it('does not silently normalize canonically equivalent text', () => {
    expect(unicodeCodePointLength('é')).toBe(1);
    expect(unicodeCodePointLength('é')).toBe(2);
  });

  it('matches the shared cross-language Unicode vector corpus', () => {
    const path = resolve(import.meta.dirname, '../../../fixtures/unicode/offset-vectors.json');
    const corpus = JSON.parse(readFileSync(path, 'utf8')) as OffsetVectorCorpus;
    for (const testCase of corpus.cases) {
      expect(unicodeCodePointLength(testCase.text), testCase.id).toBe(testCase.codePointLength);
      for (const slice of testCase.slices) {
        const span: UnicodeSpan = { ...slice, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: revision };
        expect(sliceByCodePoint(testCase.text, span), testCase.id).toBe(slice.expected);
      }
    }
  });

  it.each([
    { start: -1, end: 1 }, { start: 1, end: 1 }, { start: 2, end: 1 }, { start: 0, end: 4 }
  ])('rejects invalid bounds $start..$end', ({ start, end }) => {
    const span: UnicodeSpan = { start, end, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: revision };
    expect(() => sliceByCodePoint('abc', span)).toThrow(RangeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid canonical text length: %s',
    (textLength) => {
      const span: UnicodeSpan = { start: 0, end: 1, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: revision };
      expect(() => { assertValidSpan(span, textLength); }).toThrow(TypeError);
    }
  );

  it('rejects an invalid declared offset unit at the runtime boundary', () => {
    const span = { start: 0, end: 1, offsetUnit: 'UTF16_CODE_UNIT', extractionRevision: revision } as unknown as UnicodeSpan;
    expect(() => { assertValidSpan(span, 1); }).toThrow(TypeError);
  });

  it('rejects an invalid extraction revision at the runtime boundary', () => {
    const span = { start: 0, end: 1, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: 'not-a-digest' } as UnicodeSpan;
    expect(() => { assertValidSpan(span, 1); }).toThrow(TypeError);
  });
});
