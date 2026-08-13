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

export interface DocxRelationshipLocationV2 {
  readonly schemaVersion: '2.0.0';
  readonly kind: 'DOCX_RELATIONSHIP';
  /** The content part that owns the relationship; never the relationship target. */
  readonly sourcePart: string;
  readonly relationshipId: string;
  readonly field: 'TARGET';
}

export interface DocxXmlValueLocationV2 {
  readonly schemaVersion: '2.0.0';
  readonly kind: 'DOCX_XML_VALUE';
  readonly part: string;
  readonly element: string;
  /** One-based occurrence of the qualified element name within the declared part. */
  readonly elementOrdinal: number;
  readonly carrier: 'TEXT' | 'ATTRIBUTE';
  readonly attribute?: string;
}

/** Append-only native-location v2: every v1 location remains valid. */
export type NativeLocationV2 = NativeLocationV1 | DocxRelationshipLocationV2 | DocxXmlValueLocationV2;

/** Value-free coordinates for one completely extracted PDF text-showing operator. */
export interface PdfTextItemLocationV3 {
  readonly schemaVersion: '3.0.0';
  readonly kind: 'PDF_TEXT_ITEM';
  /** One-based page position in canonical reading order. */
  readonly page: number;
  readonly pageObject: number;
  readonly contentObject: number;
  readonly fontObject: number;
  /** One-based text-showing operator within the page content stream. */
  readonly textItem: number;
  /** Exact number of decoded glyphs/code points owned by this item. */
  readonly glyphCount: number;
}

/** Append-only native-location v3: every v1/v2 location remains valid. */
export type NativeLocationV3 = NativeLocationV2 | PdfTextItemLocationV3;

export const pdfMetadataFields = [
  'TITLE', 'AUTHOR', 'SUBJECT', 'KEYWORDS', 'CREATOR', 'PRODUCER',
  'CREATION_DATE', 'MODIFICATION_DATE', 'TRAPPED', 'XMP_TOOLKIT',
  'DC_FORMAT', 'DC_TITLE', 'DC_CREATOR', 'DC_DESCRIPTION', 'DC_SUBJECT', 'DC_DATE',
  'XMP_CREATOR_TOOL', 'XMP_CREATE_DATE', 'XMP_MODIFY_DATE', 'XMP_METADATA_DATE',
  'PDF_PRODUCER', 'PDF_KEYWORDS', 'PDF_VERSION', 'XML_LANGUAGE'
] as const;
export type PdfMetadataField = (typeof pdfMetadataFields)[number];

/** Value-free identity for one completely extracted PDF Info/XMP metadata value. */
export interface PdfMetadataValueLocationV4 {
  readonly schemaVersion: '4.0.0';
  readonly kind: 'PDF_METADATA_VALUE';
  readonly carrier: 'INFO' | 'XMP';
  readonly object: number;
  readonly field: PdfMetadataField;
  readonly occurrence: number;
}

export type NativeLocationV4 = NativeLocationV3 | PdfMetadataValueLocationV4;

/** One canonical text region and its exact adapter-owned native location. */
export interface CanonicalRegionV1 {
  readonly schemaVersion: '1.0.0';
  readonly start: number;
  readonly end: number;
  readonly offsetUnit: 'UNICODE_CODE_POINT';
  readonly role: 'VALUE';
  readonly location: NativeLocationV1;
  /** Adapter-private selector metadata; never serialize it in ordinary reports. */
  readonly selector?: Readonly<{ readonly csvHeader: string }>;
}

/** Canonical wrapper required when a source map uses a v2 native location. */
export interface CanonicalRegionV2 {
  readonly schemaVersion: '2.0.0';
  readonly start: number;
  readonly end: number;
  readonly offsetUnit: 'UNICODE_CODE_POINT';
  readonly role: 'VALUE';
  readonly location: NativeLocationV2;
  readonly selector?: Readonly<{ readonly csvHeader: string }>;
}

/** Canonical wrapper required when a source map uses a v3 native location. */
export interface CanonicalRegionV3 {
  readonly schemaVersion: '3.0.0';
  readonly start: number;
  readonly end: number;
  readonly offsetUnit: 'UNICODE_CODE_POINT';
  readonly role: 'VALUE';
  readonly location: NativeLocationV3;
}

export interface CanonicalRegionV4 {
  readonly schemaVersion: '4.0.0';
  readonly start: number;
  readonly end: number;
  readonly offsetUnit: 'UNICODE_CODE_POINT';
  readonly role: 'VALUE';
  readonly location: NativeLocationV4;
}

export type CanonicalRegion = CanonicalRegionV1 | CanonicalRegionV2 | CanonicalRegionV3 | CanonicalRegionV4;

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

const docxContentPartPattern = /^word\/(?:document|header[1-9][0-9]{0,5}|footer[1-9][0-9]{0,5}|footnotes|endnotes|comments)\.xml$/u;
const docxXmlPartPattern = /^(?:word\/(?:document|header[1-9][0-9]{0,5}|footer[1-9][0-9]{0,5}|footnotes|endnotes|comments|styles|numbering|settings|webSettings|fontTable|theme\/theme[1-9][0-9]{0,5}|drawings\/drawing[1-9][0-9]{0,5}|charts\/chart[1-9][0-9]{0,5})|docProps\/(?:core|app|custom)|customXml\/(?:item|itemProps)[1-9][0-9]{0,5})\.xml$/u;
const docxQNamePattern = /^(?:[A-Za-z_][A-Za-z0-9_.-]{0,63}:)?[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;

export function isNativeLocationV2(value: unknown): value is NativeLocationV2 {
  if (isNativeLocationV1(value)) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const location = value as Readonly<Record<string, unknown>>;
  if (location.schemaVersion !== '2.0.0') return false;
  if (location.kind === 'DOCX_RELATIONSHIP') {
    return Object.keys(location).length === 5
      && typeof location.sourcePart === 'string'
      && docxContentPartPattern.test(location.sourcePart)
      && typeof location.relationshipId === 'string'
      && /^rId[1-9][0-9]{0,5}$/u.test(location.relationshipId)
      && location.field === 'TARGET';
  }
  if (location.kind !== 'DOCX_XML_VALUE'
    || (Object.keys(location).length !== 6 && Object.keys(location).length !== 7)
    || typeof location.part !== 'string'
    || !docxXmlPartPattern.test(location.part)
    || typeof location.element !== 'string'
    || !docxQNamePattern.test(location.element)
    || !Number.isSafeInteger(location.elementOrdinal)
    || (location.elementOrdinal as number) < 1
    || (location.elementOrdinal as number) > 1_000_000) return false;
  if (location.carrier === 'TEXT') return Object.keys(location).length === 6;
  return location.carrier === 'ATTRIBUTE'
    && Object.keys(location).length === 7
    && typeof location.attribute === 'string'
    && docxQNamePattern.test(location.attribute);
}

export function isNativeLocationV3(value: unknown): value is NativeLocationV3 {
  if (isNativeLocationV2(value)) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const location = value as Readonly<Record<string, unknown>>;
  return Object.keys(location).length === 8
    && location.schemaVersion === '3.0.0'
    && location.kind === 'PDF_TEXT_ITEM'
    && Number.isSafeInteger(location.page)
    && (location.page as number) >= 1
    && (location.page as number) <= 10_000
    && Number.isSafeInteger(location.pageObject)
    && (location.pageObject as number) >= 1
    && (location.pageObject as number) <= 1_000_000
    && Number.isSafeInteger(location.contentObject)
    && (location.contentObject as number) >= 1
    && (location.contentObject as number) <= 1_000_000
    && Number.isSafeInteger(location.fontObject)
    && (location.fontObject as number) >= 1
    && (location.fontObject as number) <= 1_000_000
    && Number.isSafeInteger(location.textItem)
    && (location.textItem as number) >= 1
    && (location.textItem as number) <= 1_000_000
    && Number.isSafeInteger(location.glyphCount)
    && (location.glyphCount as number) >= 1
    && (location.glyphCount as number) <= 4_096;
}

export function isNativeLocationV4(value: unknown): value is NativeLocationV4 {
  if (isNativeLocationV3(value)) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const location = value as Readonly<Record<string, unknown>>;
  return Object.keys(location).length === 6
    && location.schemaVersion === '4.0.0'
    && location.kind === 'PDF_METADATA_VALUE'
    && (location.carrier === 'INFO' || location.carrier === 'XMP')
    && Number.isSafeInteger(location.object)
    && (location.object as number) >= 1
    && (location.object as number) <= 1_000_000
    && typeof location.field === 'string'
    && (pdfMetadataFields as readonly string[]).includes(location.field)
    && Number.isSafeInteger(location.occurrence)
    && (location.occurrence as number) >= 1
    && (location.occurrence as number) <= 1_000_000;
}

export function nativeLocationIdentity(location: NativeLocationV4): string {
  if (location.kind === 'JSON_POINTER') return `JSON_POINTER\u0000${location.pointer}`;
  if (location.kind === 'CSV_CELL') {
    return `CSV_CELL\u0000${String(location.row)}\u0000${String(location.column)}`;
  }
  if (location.kind === 'DOCX_PART') {
    return `DOCX_PART\u0000${location.part}\u0000${String(location.paragraph)}`;
  }
  if (location.kind === 'DOCX_RELATIONSHIP') {
    return `DOCX_RELATIONSHIP\u0000${location.sourcePart}\u0000${location.relationshipId}\u0000TARGET`;
  }
  if (location.kind === 'DOCX_XML_VALUE') {
    return `DOCX_XML_VALUE\u0000${location.part}\u0000${location.element}\u0000${String(location.elementOrdinal)}\u0000${location.carrier}${location.attribute === undefined ? '' : `\u0000${location.attribute}`}`;
  }
  if (location.kind === 'PDF_TEXT_ITEM') {
    return `PDF_TEXT_ITEM\u0000${String(location.page)}\u0000${String(location.pageObject)}\u0000${String(location.contentObject)}\u0000${String(location.fontObject)}\u0000${String(location.textItem)}\u0000${String(location.glyphCount)}`;
  }
  return `PDF_METADATA_VALUE\u0000${location.carrier}\u0000${String(location.object)}\u0000${location.field}\u0000${String(location.occurrence)}`;
}

export interface DetectionEvidence {
  readonly id: DetectionId;
  readonly entityType: EntityType;
  readonly span: UnicodeSpan;
  readonly confidence: number;
  readonly source: DetectorSource;
  readonly detector: DetectorReference;
  readonly nativeLocations?: readonly NativeLocationV4[];
}

export interface DetectionSet {
  readonly extractionRevision: Sha256Digest;
  readonly detectorBundleVersion: string;
  readonly complete: boolean;
  readonly evidence: readonly DetectionEvidence[];
}
