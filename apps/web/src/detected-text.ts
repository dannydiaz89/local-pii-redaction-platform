import type { JobDetectionSummary } from '@local-pii/sdk';

const maximumDetectionRows = 100;
const maximumDetectedTextCodePoints = 256;

interface DetectionBoundary {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('DETECTED_TEXT_ABORTED');
}

function validBoundaries(
  detections: readonly JobDetectionSummary[]
): readonly DetectionBoundary[] | undefined {
  if (detections.length > maximumDetectionRows) return undefined;
  const seen = new Set<string>();
  const boundaries: DetectionBoundary[] = [];
  for (const { id, start, end } of detections) {
    if (seen.has(id)
      || !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || end <= start
      || end - start > maximumDetectedTextCodePoints) return undefined;
    seen.add(id);
    boundaries.push({ id, start, end });
  }
  return boundaries;
}

/**
 * Reads exact detection text from the user-selected local file after an explicit reveal action.
 * Only the bounded matches are returned; the complete decoded document is not retained.
 */
export async function readDetectedText(
  file: File,
  detections: readonly JobDetectionSummary[],
  signal: AbortSignal
): Promise<ReadonlyMap<string, string>> {
  throwIfAborted(signal);
  const boundaries = validBoundaries(detections);
  if (boundaries === undefined) throw new Error('DETECTED_TEXT_UNAVAILABLE');
  if (boundaries.length === 0) return new Map();

  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  let sourceText: string;
  try {
    throwIfAborted(signal);
    sourceText = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  } finally {
    sourceBytes.fill(0);
  }

  const requestedPositions = [...new Set(boundaries.flatMap(({ start, end }) => [start, end]))]
    .sort((left, right) => left - right);
  const utf16Offsets = new Map<number, number>();
  let positionIndex = 0;
  let codePointOffset = 0;
  let utf16Offset = 0;

  while (requestedPositions[positionIndex] === 0) {
    utf16Offsets.set(0, 0);
    positionIndex += 1;
  }
  for (const character of sourceText) {
    codePointOffset += 1;
    utf16Offset += character.length;
    while (requestedPositions[positionIndex] === codePointOffset) {
      utf16Offsets.set(codePointOffset, utf16Offset);
      positionIndex += 1;
    }
    if (positionIndex >= requestedPositions.length) break;
  }
  throwIfAborted(signal);

  const matches = new Map<string, string>();
  for (const { id, start, end } of boundaries) {
    const utf16Start = utf16Offsets.get(start);
    const utf16End = utf16Offsets.get(end);
    if (utf16Start === undefined || utf16End === undefined) {
      throw new Error('DETECTED_TEXT_UNAVAILABLE');
    }
    matches.set(id, sourceText.slice(utf16Start, utf16End));
  }
  sourceText = '';
  return matches;
}
