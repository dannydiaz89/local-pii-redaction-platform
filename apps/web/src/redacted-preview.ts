export const redactedPreviewMaximumCodePoints = 4_096;

export interface RedactedTextPreview {
  readonly text: string;
  readonly codePoints: number;
  readonly truncated: boolean;
}

/**
 * Decodes only a bounded UTF-8 prefix and returns plain text for React to escape.
 * Four bytes per code point plus a possible BOM is sufficient for the preview window.
 */
export function createRedactedTextPreview(
  bytes: Uint8Array,
  maximumCodePoints = redactedPreviewMaximumCodePoints
): RedactedTextPreview {
  if (!Number.isSafeInteger(maximumCodePoints) || maximumCodePoints < 1 || maximumCodePoints > 16_384) {
    throw new TypeError('The redacted preview limit is invalid.');
  }
  const maximumPrefixBytes = maximumCodePoints * 4 + 3;
  const prefixByteLength = Math.min(bytes.byteLength, maximumPrefixBytes);
  const hasRemainingBytes = prefixByteLength < bytes.byteLength;
  let decoded = new TextDecoder('utf-8', { fatal: true }).decode(
    bytes.subarray(0, prefixByteLength),
    { stream: hasRemainingBytes }
  );
  if (decoded.startsWith('\uFEFF')) decoded = decoded.slice(1);

  let text = '';
  let codePoints = 0;
  let truncated = hasRemainingBytes;
  for (const character of decoded) {
    if (codePoints === maximumCodePoints) {
      truncated = true;
      break;
    }
    text += character;
    codePoints += 1;
  }
  return Object.freeze({ text, codePoints, truncated });
}
