import { describe, expect, it } from 'vitest';

import { parseSha256Digest, sliceByCodePoint, unicodeCodePointLength, type UnicodeSpan } from '../src/index.js';

const revision = parseSha256Digest(`sha256:${'a'.repeat(64)}`);

describe('Unicode code-point spans', () => {
  it('counts astral characters as one code point rather than two UTF-16 units', () => {
    expect(unicodeCodePointLength('A😀B')).toBe(3);
    const span: UnicodeSpan = { start: 1, end: 2, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: revision };
    expect(sliceByCodePoint('A😀B', span)).toBe('😀');
  });

  it('preserves combining marks as distinct code points', () => {
    expect(unicodeCodePointLength('é')).toBe(2);
  });

  it.each([
    { start: -1, end: 1 }, { start: 1, end: 1 }, { start: 2, end: 1 }, { start: 0, end: 4 }
  ])('rejects invalid bounds $start..$end', ({ start, end }) => {
    const span: UnicodeSpan = { start, end, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: revision };
    expect(() => sliceByCodePoint('abc', span)).toThrow(RangeError);
  });
});
