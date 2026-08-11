import type { JobDetectionSummary } from '@local-pii/sdk';

const contextCodePointsBefore = 80;
const contextCodePointsAfter = 120;
const maximumDetectedTextCodePoints = 256;

export interface SourceDetectionContext {
  readonly detectionId: string;
  readonly before: string;
  readonly match: string;
  readonly after: string;
  readonly leadingTruncated: boolean;
  readonly trailingTruncated: boolean;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('SOURCE_CONTEXT_ABORTED');
}

/**
 * Reads one bounded, escaped-by-the-renderer context window from the already-selected local file.
 * The complete decoded document is used only transiently to resolve Unicode code-point offsets and
 * is never returned from this boundary.
 */
export async function readSourceDetectionContext(
  file: File,
  detection: JobDetectionSummary,
  signal: AbortSignal
): Promise<SourceDetectionContext> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(detection.start)
    || !Number.isSafeInteger(detection.end)
    || detection.start < 0
    || detection.end <= detection.start
    || detection.end - detection.start > maximumDetectedTextCodePoints) {
    throw new Error('SOURCE_CONTEXT_UNAVAILABLE');
  }

  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  let sourceText: string;
  try {
    throwIfAborted(signal);
    sourceText = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  } finally {
    sourceBytes.fill(0);
  }

  try {
    const windowStart = Math.max(0, detection.start - contextCodePointsBefore);
    const requestedWindowEnd = detection.end + contextCodePointsAfter;
    const requested = new Set([windowStart, detection.start, detection.end, requestedWindowEnd]);
    const utf16Offsets = new Map<number, number>();
    let codePointOffset = 0;
    let utf16Offset = 0;
    if (requested.has(0)) utf16Offsets.set(0, 0);
    for (const character of sourceText) {
      codePointOffset += 1;
      utf16Offset += character.length;
      if (requested.has(codePointOffset)) utf16Offsets.set(codePointOffset, utf16Offset);
    }
    throwIfAborted(signal);
    if (detection.end > codePointOffset) throw new Error('SOURCE_CONTEXT_UNAVAILABLE');

    const windowEnd = Math.min(requestedWindowEnd, codePointOffset);
    if (!utf16Offsets.has(windowEnd)) utf16Offsets.set(windowEnd, sourceText.length);
    const utf16WindowStart = utf16Offsets.get(windowStart);
    const utf16Start = utf16Offsets.get(detection.start);
    const utf16End = utf16Offsets.get(detection.end);
    const utf16WindowEnd = utf16Offsets.get(windowEnd);
    if (utf16WindowStart === undefined
      || utf16Start === undefined
      || utf16End === undefined
      || utf16WindowEnd === undefined) {
      throw new Error('SOURCE_CONTEXT_UNAVAILABLE');
    }

    return Object.freeze({
      detectionId: detection.id,
      before: sourceText.slice(utf16WindowStart, utf16Start),
      match: sourceText.slice(utf16Start, utf16End),
      after: sourceText.slice(utf16End, utf16WindowEnd),
      leadingTruncated: windowStart > 0,
      trailingTruncated: windowEnd < codePointOffset
    });
  } finally {
    sourceText = '';
  }
}
