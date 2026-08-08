import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import {
  SafeError,
  type DetectionEvidence,
  type DetectorSource,
  type EntityType,
  type Sha256Digest
} from '@local-pii/domain';

export const deterministicDetectorBundleVersion = '0.1.0';

const detectorIds = {
  email: 'email-pattern',
  phone: 'phone-pattern',
  ssn: 'ssn-structure',
  paymentCard: 'payment-card-luhn',
  ip: 'ip-parser',
  secret: 'secret-assignment'
} as const;

export const deterministicDetectorCapabilities = [
  { id: detectorIds.email, version: deterministicDetectorBundleVersion, kinds: ['REGEX'], entityTypes: ['EMAIL'], languages: ['und'] },
  { id: detectorIds.phone, version: deterministicDetectorBundleVersion, kinds: ['REGEX'], entityTypes: ['PHONE'], languages: ['und'] },
  { id: detectorIds.ssn, version: deterministicDetectorBundleVersion, kinds: ['CHECKSUM'], entityTypes: ['SSN'], languages: ['en-US'] },
  { id: detectorIds.paymentCard, version: deterministicDetectorBundleVersion, kinds: ['CHECKSUM'], entityTypes: ['CREDIT_CARD'], languages: ['und'] },
  { id: detectorIds.ip, version: deterministicDetectorBundleVersion, kinds: ['CHECKSUM'], entityTypes: ['IP_ADDRESS'], languages: ['und'] },
  { id: detectorIds.secret, version: deterministicDetectorBundleVersion, kinds: ['REGEX'], entityTypes: ['API_KEY', 'ACCESS_TOKEN', 'PASSWORD'], languages: ['und'] }
] as const;

export interface DetectorLimits {
  readonly maximumCodePoints: number;
  readonly maximumDetections: number;
  readonly maximumCandidateLength: number;
}

export const defaultDetectorLimits: DetectorLimits = {
  maximumCodePoints: 10_000_000,
  maximumDetections: 10_000,
  maximumCandidateLength: 256
};

interface Candidate {
  readonly entityType: EntityType;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly confidence: number;
  readonly source: DetectorSource;
  readonly detectorId: string;
  readonly ruleId: string;
}

function utf16ToCodePointMap(text: string): Int32Array {
  const mapping = new Int32Array(text.length + 1);
  let utf16Index = 0;
  let codePointIndex = 0;
  while (utf16Index < text.length) {
    mapping[utf16Index] = codePointIndex;
    const value = text.codePointAt(utf16Index);
    const width = value !== undefined && value > 0xffff ? 2 : 1;
    if (width === 2) mapping[utf16Index + 1] = codePointIndex;
    utf16Index += width;
    codePointIndex += 1;
  }
  mapping[text.length] = codePointIndex;
  return mapping;
}

function stableUuid(parts: readonly (string | number)[]): string {
  const bytes = createHash('sha256').update(parts.join('\u001f'), 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function addMatches(
  candidates: Candidate[],
  text: string,
  pattern: RegExp,
  create: (match: RegExpExecArray) => Omit<Candidate, 'startUtf16' | 'endUtf16'> | undefined,
  selectSpan: (match: RegExpExecArray) => { readonly start: number; readonly end: number } = (match) => ({
    start: match.index,
    end: match.index + match[0].length
  })
): void {
  for (const match of text.matchAll(pattern)) {
    const definition = create(match);
    if (definition === undefined) continue;
    const span = selectSpan(match);
    candidates.push({ ...definition, startUtf16: span.start, endUtf16: span.end });
  }
}

function validSsn(value: string): boolean {
  const [area, group, serial] = value.split('-');
  if (area === undefined || group === undefined || serial === undefined) return false;
  const areaNumber = Number(area);
  return area !== '000' && areaNumber !== 666 && areaNumber < 900 && group !== '00' && serial !== '0000';
}

function validLuhn(value: string): boolean {
  const digits = value.replaceAll(/[ -]/gu, '');
  if (!/^\d{13,19}$/u.test(digits) || /^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function collectCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = [];

  addMatches(candidates, text, /(?<![\w.+-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+(?![\w-])/giu, () => ({
    entityType: 'EMAIL', confidence: 0.99, source: 'REGEX', detectorId: detectorIds.email, ruleId: 'email-v1'
  }));

  addMatches(candidates, text, /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/gu, (match) => validSsn(match[0]) ? ({
    entityType: 'SSN', confidence: 1, source: 'CHECKSUM', detectorId: detectorIds.ssn, ruleId: 'us-ssn-v1'
  }) : undefined);

  addMatches(candidates, text, /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/gu, (match) => validLuhn(match[0]) ? ({
    entityType: 'CREDIT_CARD', confidence: 1, source: 'CHECKSUM', detectorId: detectorIds.paymentCard, ruleId: 'luhn-v1'
  }) : undefined);

  addMatches(candidates, text, /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/gu, (match) => {
    const valid = match[0].split('.').every((part) => Number(part) <= 255 && (part === '0' || !part.startsWith('0')));
    return valid ? { entityType: 'IP_ADDRESS', confidence: 1, source: 'CHECKSUM', detectorId: detectorIds.ip, ruleId: 'ipv4-v1' } : undefined;
  });

  addMatches(candidates, text, /(?<![0-9A-Fa-f:])[0-9A-Fa-f:]{2,39}(?![0-9A-Fa-f:])/gu, (match) => isIP(match[0]) === 6 ? ({
    entityType: 'IP_ADDRESS', confidence: 1, source: 'CHECKSUM', detectorId: detectorIds.ip, ruleId: 'ipv6-v1'
  }) : undefined);

  addMatches(candidates, text, /(?<!\w)(?:\+?\d[\d ().-]{5,}\d)(?!\w)/gu, (match) => {
    const digits = match[0].replaceAll(/\D/gu, '');
    return digits.length >= 7 && digits.length <= 15
      ? { entityType: 'PHONE', confidence: 0.86, source: 'REGEX', detectorId: detectorIds.phone, ruleId: 'phone-general-v1' }
      : undefined;
  });

  const secretPattern = /\b(api[_-]?key|access[_-]?token|password)\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{12,128})["']?/giu;
  addMatches(candidates, text, secretPattern, (match) => {
    const key = match[1]?.toLowerCase();
    const entityType: EntityType = key?.startsWith('password') === true
      ? 'PASSWORD'
      : key?.includes('token') === true ? 'ACCESS_TOKEN' : 'API_KEY';
    return { entityType, confidence: 0.98, source: 'REGEX', detectorId: detectorIds.secret, ruleId: 'secret-assignment-v1' };
  }, (match) => {
    const value = match[2] ?? '';
    const relativeStart = match[0].lastIndexOf(value);
    return { start: match.index + relativeStart, end: match.index + relativeStart + value.length };
  });

  return candidates;
}

export function detectDeterministic(
  text: string,
  extractionRevision: Sha256Digest,
  limits: DetectorLimits = defaultDetectorLimits,
  correlationId = 'cor_local_detection'
): readonly DetectionEvidence[] {
  const mapping = utf16ToCodePointMap(text);
  const codePointLength = mapping[text.length] ?? 0;
  if (codePointLength > limits.maximumCodePoints) {
    throw new SafeError({ code: 'INPUT_TOO_LARGE', message: 'Canonical text exceeds the detector limit.', retryable: false, correlationId });
  }

  const candidates = collectCandidates(text);
  if (candidates.length > limits.maximumDetections) {
    throw new SafeError({ code: 'DETECTION_LIMIT_EXCEEDED', message: 'Detection count exceeds the configured safety limit.', retryable: false, correlationId });
  }

  return candidates.map((candidate) => {
    if (candidate.endUtf16 - candidate.startUtf16 > limits.maximumCandidateLength) {
      throw new SafeError({ code: 'DETECTION_LIMIT_EXCEEDED', message: 'A detector candidate exceeds the span-length limit.', retryable: false, correlationId });
    }
    const start = mapping[candidate.startUtf16];
    const end = mapping[candidate.endUtf16];
    if (start === undefined || end === undefined || start >= end) {
      throw new SafeError({ code: 'SOURCE_MAP_INVALID', message: 'A detector returned an invalid Unicode span.', retryable: false, correlationId });
    }
    return {
      id: stableUuid([extractionRevision, candidate.detectorId, candidate.ruleId, candidate.entityType, start, end]),
      entityType: candidate.entityType,
      span: { start, end, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision },
      confidence: candidate.confidence,
      source: candidate.source,
      detector: { id: candidate.detectorId, version: deterministicDetectorBundleVersion, ruleId: candidate.ruleId }
    } satisfies DetectionEvidence;
  }).sort((left, right) => left.span.start - right.span.start || right.span.end - left.span.end || left.entityType.localeCompare(right.entityType));
}
