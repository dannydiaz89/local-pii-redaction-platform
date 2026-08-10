import type { DetectionId, Sha256Digest } from './identifiers.js';
import type { UnicodeSpan } from './span.js';

export const entityTypes = [
  'PERSON', 'EMAIL', 'PHONE', 'ADDRESS', 'LOCATION', 'ORGANIZATION',
  'DATE_OF_BIRTH', 'SSN', 'NATIONAL_ID', 'PASSPORT', 'DRIVER_LICENSE',
  'CREDIT_CARD', 'BANK_ACCOUNT', 'ROUTING_NUMBER', 'MEDICAL_RECORD',
  'HEALTH_PLAN_ID', 'ACCOUNT_ID', 'USERNAME', 'IP_ADDRESS', 'MAC_ADDRESS',
  'API_KEY', 'ACCESS_TOKEN', 'PASSWORD', 'CUSTOM'
] as const;

export type EntityType = (typeof entityTypes)[number];
export const detectorSources = ['REGEX', 'CHECKSUM', 'STRUCTURED', 'DICTIONARY', 'MODEL', 'MANUAL'] as const;
export type DetectorSource = (typeof detectorSources)[number];

export interface DetectorReference {
  readonly id: string;
  readonly version: string;
  readonly ruleId?: string;
}

export interface JsonPointerLocationV1 {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'JSON_POINTER';
  /** RFC 6901 JSON Pointer. The empty string identifies the document root. */
  readonly pointer: string;
}

export interface CsvCellLocationV1 {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'CSV_CELL';
  /** One-based logical CSV record, independent of quoted physical newlines. */
  readonly row: number;
  /** One-based CSV column. */
  readonly column: number;
}

export interface DocxPartLocationV1 {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'DOCX_PART';
  /** Bounded content-part name inside the DOCX package. */
  readonly part: string;
  /** One-based logical paragraph ordinal within the declared part. */
  readonly paragraph: number;
}

/** Versioned value-free native location for currently qualified structured formats. */
export type NativeLocationV1 = JsonPointerLocationV1 | CsvCellLocationV1 | DocxPartLocationV1;

/** One canonical text region and its exact adapter-owned native location. */
export interface CanonicalRegionV1 {
  readonly schemaVersion: '1.0.0';
  readonly start: number;
  readonly end: number;
  readonly offsetUnit: 'UNICODE_CODE_POINT';
  readonly role: 'VALUE';
  readonly location: NativeLocationV1;
}

export function isNativeLocationV1(value: unknown): value is NativeLocationV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const location = value as Readonly<Record<string, unknown>>;
  if (location.schemaVersion !== '1.0.0') return false;
  if (location.kind === 'CSV_CELL') {
    return Object.keys(location).length === 4
      && Number.isSafeInteger(location.row)
      && (location.row as number) >= 1
      && (location.row as number) <= 100_000
      && Number.isSafeInteger(location.column)
      && (location.column as number) >= 1
      && (location.column as number) <= 1_000;
  }
  if (location.kind === 'DOCX_PART') {
    return Object.keys(location).length === 4
      && typeof location.part === 'string'
      && /^word\/(?:document|header[1-9][0-9]*|footer[1-9][0-9]*|footnotes|endnotes|comments)\.xml$/u.test(location.part)
      && Number.isSafeInteger(location.paragraph)
      && (location.paragraph as number) >= 1
      && (location.paragraph as number) <= 1_000_000;
  }
  if (location.kind !== 'JSON_POINTER'
    || Object.keys(location).length !== 3
    || typeof location.pointer !== 'string'
    || location.pointer.length > 500
    || (location.pointer.length > 0 && !location.pointer.startsWith('/'))) return false;
  for (let index = 0; index < location.pointer.length; index += 1) {
    if (location.pointer[index] === '~') {
      const escaped = location.pointer[index + 1];
      if (escaped !== '0' && escaped !== '1') return false;
      index += 1;
    }
  }
  return true;
}

export function nativeLocationIdentity(location: NativeLocationV1): string {
  if (location.kind === 'JSON_POINTER') return `JSON_POINTER\u0000${location.pointer}`;
  if (location.kind === 'CSV_CELL') {
    return `CSV_CELL\u0000${String(location.row)}\u0000${String(location.column)}`;
  }
  return `DOCX_PART\u0000${location.part}\u0000${String(location.paragraph)}`;
}

export interface DetectionEvidence {
  readonly id: DetectionId;
  readonly entityType: EntityType;
  readonly span: UnicodeSpan;
  readonly confidence: number;
  readonly source: DetectorSource;
  readonly detector: DetectorReference;
  readonly nativeLocations?: readonly NativeLocationV1[];
}

export interface DetectionSet {
  readonly extractionRevision: Sha256Digest;
  readonly detectorBundleVersion: string;
  readonly complete: boolean;
  readonly evidence: readonly DetectionEvidence[];
}
