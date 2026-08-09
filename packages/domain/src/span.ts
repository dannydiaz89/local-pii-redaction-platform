import { parseSha256Digest, type Sha256Digest } from './identifiers.js';

export interface UnicodeSpan {
  readonly start: number;
  readonly end: number;
  readonly offsetUnit: 'UNICODE_CODE_POINT';
  readonly extractionRevision: Sha256Digest;
}

export function unicodeCodePointLength(text: string): number {
  // Intentional: portable offsets are Unicode code points, not grapheme clusters.
  let length = 0;
  for (let index = 0; index < text.length; length += 1) {
    const value = text.codePointAt(index);
    index += value !== undefined && value > 0xffff ? 2 : 1;
  }
  return length;
}

export function assertValidSpan(span: UnicodeSpan, textLength: number): void {
  if (!Number.isSafeInteger(textLength) || textLength < 0) throw new TypeError('Invalid canonical text length');
  const offsetUnit: unknown = span.offsetUnit;
  if (offsetUnit !== 'UNICODE_CODE_POINT') throw new TypeError('Invalid span offset unit');
  parseSha256Digest(span.extractionRevision);
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)) throw new TypeError('Span offsets must be safe integers');
  if (span.start < 0 || span.start >= span.end || span.end > textLength) {
    throw new RangeError('Span must satisfy 0 <= start < end <= canonical text length');
  }
}

export function sliceByCodePoint(text: string, span: UnicodeSpan): string {
  assertValidSpan(span, unicodeCodePointLength(text));
  // Intentional: the contract defines half-open Unicode code-point offsets.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  return [...text].slice(span.start, span.end).join('');
}
