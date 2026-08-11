import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import {
  defaultTextArtifactFileSystem,
  deriveRedactedOutputPath,
  discardStagedTextArtifact,
  publishStagedTextArtifact,
  type StagedTextArtifact,
  type TextArtifactFileSystem,
  type TextArtifactPublication
} from '@local-pii/adapter-text';
import { computeWriterReceiptDigest, type RedactionWriterReceiptContract } from '@local-pii/contracts';
import {
  SafeError,
  parseSha256Digest,
  unicodeCodePointLength,
  type CanonicalRegion,
  type DocxRelationshipLocationV2,
  type DocxXmlValueLocationV2,
  type Sha256Digest
} from '@local-pii/domain';
import { assertTypedLabelPlanIntegrity, type TypedLabelAction, type TypedLabelPlan } from '@local-pii/redaction';

export const docxAdapterVersion = '0.5.0';
export const defaultMaximumDocxInputBytes = 25 * 1024 * 1024;
export const docxWriterDescriptor = Object.freeze({
  id: 'docx-adapter',
  version: docxAdapterVersion,
  digest: parseSha256Digest('sha256:2e54f6b245808c31c1711a0252b526608aceaa741814fba9e435e2dea6f1bd24')
});
export const docxAdapterCapabilityDescriptor = {
  id: 'docx',
  adapter: docxWriterDescriptor.id,
  version: docxAdapterVersion,
  mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  extensions: ['.docx'],
  operations: ['PROBE', 'INSPECT', 'EXTRACT', 'SCAN'],
  assurance: 'EXTRACT_ONLY',
  features: [
    { id: 'visible-document-paragraphs-and-tables', status: 'SUPPORTED' },
    { id: 'visible-header-footer-footnote-and-endnote-text', status: 'SUPPORTED' },
    { id: 'structural-tabs-and-note-references', status: 'SUPPORTED' },
    { id: 'strict-passive-word-support-parts', status: 'SUPPORTED' },
    { id: 'scanned-external-hyperlink-targets', status: 'SUPPORTED' },
    { id: 'scanned-generated-numbering-and-style-metadata', status: 'SUPPORTED' },
    { id: 'fragmented-run-source-map', status: 'SUPPORTED' },
    { id: 'unicode-code-point-offsets', status: 'SUPPORTED' },
    { id: 'native-reopen', status: 'SUPPORTED' },
    { id: 'deflate-compression-option-flags', status: 'SUPPORTED' },
    { id: 'opc-growth-hint-extra-field', status: 'SUPPORTED' },
    { id: 'macros-and-active-content', status: 'BLOCKED' },
    { id: 'non-hyperlink-external-relationships', status: 'BLOCKED' },
    { id: 'metadata-comments-and-additional-text-parts', status: 'BLOCKED' },
    { id: 'images-drawings-and-embedded-objects', status: 'BLOCKED' },
    { id: 'revisions-fields-hidden-text-and-controls', status: 'BLOCKED' },
    { id: 'zip64-and-encrypted-entries', status: 'BLOCKED' },
    { id: 'symbolic-links', status: 'BLOCKED' },
    { id: 'sandboxed-worker-isolation', status: 'BLOCKED' }
  ],
  verificationProfiles: ['docx-extract-v1'],
  limits: { maximumInputBytes: defaultMaximumDocxInputBytes }
} as const;

/**
 * Preflight/extraction assurance only. This is not a redaction-verification
 * profile and must never authorize publication of a derived DOCX artifact.
 */
export const docxExtractionVerificationCapabilityDescriptor = {
  id: 'docx-extract-v1',
  version: docxAdapterVersion,
  formats: ['docx'],
  checks: ['ZIP_STRUCTURE', 'FEATURE_ALLOWLIST', 'NATIVE_SOURCE_MAP']
} as const;

type WriterReceipt = RedactionWriterReceiptContract.WriterReceipt;

const maximumZipEntries = 256;
const maximumExpandedBytes = 50 * 1024 * 1024;
const maximumEntryBytes = 10 * 1024 * 1024;
const maximumCompressionRatio = 100;
const maximumGrowthHintPaddingBytes = 4 * 1024;
const maximumParagraphs = 50_000;
const maximumTextNodes = 100_000;
const maximumXmlElements = 250_000;
const maximumXmlDepth = 128;
const maximumXmlAttributes = 64;
const maximumXmlTagCodeUnits = 32 * 1024;
const maximumCanonicalCodePoints = 10_000_000;
const maximumCanonicalCarriers = 10_000;
const maximumRelationshipTargetCodePoints = 2_048;
const maximumPlanActions = 100_000;
const actionIdPattern = /^act_[0-9A-HJKMNP-TV-Z]{26}$/u;
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationshipPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const officeRelationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const docxMediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const documentPartContentTypes = new Set([
  docxMediaType,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
]);
const paragraphBoundary = '\n\u0000\n';
const carrierBoundary = '\n\u0000DOCX-CARRIER\u0000\n';

function formatCorrupt(): never {
  throw new SafeError({
    code: 'FORMAT_CORRUPT',
    message: 'The DOCX input is malformed or exceeds the supported archive or document limits.',
    retryable: false,
    correlationId: 'cor_docx_adapter'
  });
}

type UnsupportedFeatureReason =
  | 'additional_text_part'
  | 'external_relationship'
  | 'drawing_or_alternate_content'
  | 'metadata_part'
  | 'unknown_feature';

function featureUnsupported(reason: UnsupportedFeatureReason = 'unknown_feature'): never {
  throw new SafeError({
    code: 'FORMAT_UNSUPPORTED',
    message: 'The DOCX input contains a feature outside this adapter’s declared safe text surface.',
    retryable: false,
    correlationId: 'cor_docx_adapter',
    details: { reason }
  });
}

function digestBytes(bytes: Uint8Array): Sha256Digest {
  return parseSha256Digest(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function storageUnavailable(message: string): SafeError {
  return new SafeError({ code: 'STORAGE_UNAVAILABLE', message, retryable: true, correlationId: 'cor_docx_adapter' });
}

interface ZipEntry {
  readonly name: string;
  readonly method: 0 | 8;
  readonly contents: Buffer;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function checkedRange(buffer: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) formatCorrupt();
}

function u16(buffer: Buffer, offset: number): number {
  checkedRange(buffer, offset, 2);
  return buffer.readUInt16LE(offset);
}

function u32(buffer: Buffer, offset: number): number {
  checkedRange(buffer, offset, 4);
  return buffer.readUInt32LE(offset);
}

function safeEntryName(bytes: Buffer, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) formatCorrupt();
  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return formatCorrupt();
  }
  if (
    name.length === 0
    || name.length > 240
    || name.startsWith('/')
    || name.endsWith('/')
    || name.includes('\\')
    || name.includes('\u0000')
    || name.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) formatCorrupt();
  return name;
}

function validZipFlags(flags: number, method: number): boolean {
  const encodingFlag = flags & 0x0800;
  const compressionOptions = flags & 0x0006;
  return (flags & ~0x0806) === 0
    && (encodingFlag === 0 || encodingFlag === 0x0800)
    && (method === 8 || compressionOptions === 0);
}

function assertSupportedLocalExtra(extra: Buffer): void {
  if (extra.length === 0) return;
  if (extra.length < 8 || extra.length > maximumGrowthHintPaddingBytes + 8) formatCorrupt();
  const fieldId = u16(extra, 0);
  const fieldLength = u16(extra, 2);
  if (fieldId !== 0xa220 || fieldLength !== extra.length - 4 || fieldLength < 4) formatCorrupt();
  const signature = u16(extra, 4);
  const initialPaddingLength = u16(extra, 6);
  const padding = extra.subarray(8);
  if (
    signature !== 0xa028
    || initialPaddingLength !== padding.length
    || !padding.every((value) => value === 0)
  ) formatCorrupt();
}

function parseZip(bytes: Buffer): readonly ZipEntry[] {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) formatCorrupt();
  let eocd = -1;
  const firstCandidate = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= firstCandidate; index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) formatCorrupt();
  const commentLength = u16(bytes, eocd + 20);
  if (eocd + 22 + commentLength !== bytes.length || commentLength !== 0) formatCorrupt();
  if (u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0) formatCorrupt();
  const diskEntries = u16(bytes, eocd + 8);
  const entryCount = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if (entryCount === 0 || entryCount > maximumZipEntries || diskEntries !== entryCount) formatCorrupt();
  if (centralOffset + centralSize !== eocd || centralOffset >= eocd) formatCorrupt();

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const foldedNames = new Set<string>();
  const localRanges: Array<readonly [number, number]> = [];
  let totalExpanded = 0;
  let cursor = centralOffset;
  for (let count = 0; count < entryCount; count += 1) {
    if (u32(bytes, cursor) !== 0x02014b50) formatCorrupt();
    const versionMadeBy = u16(bytes, cursor + 4);
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    const expectedCrc = u32(bytes, cursor + 16);
    const compressedSize = u32(bytes, cursor + 20);
    const expandedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const entryCommentLength = u16(bytes, cursor + 32);
    const diskStart = u16(bytes, cursor + 34);
    const internalAttributes = u16(bytes, cursor + 36);
    const externalAttributes = u32(bytes, cursor + 38);
    const localOffset = u32(bytes, cursor + 42);
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    checkedRange(bytes, cursor, recordLength);
    if (
      (versionMadeBy >>> 8) !== 0 || !validZipFlags(flags, method) || (method !== 0 && method !== 8)
      || diskStart !== 0 || internalAttributes !== 0 || externalAttributes !== 0
      || extraLength !== 0 || entryCommentLength !== 0
    ) formatCorrupt();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = safeEntryName(nameBytes, (flags & 0x0800) !== 0);
    const folded = name.toLocaleLowerCase('en-US');
    if (names.has(name) || foldedNames.has(folded)) formatCorrupt();
    names.add(name);
    foldedNames.add(folded);
    if (expandedSize > maximumEntryBytes || totalExpanded + expandedSize > maximumExpandedBytes) formatCorrupt();
    if (expandedSize > compressedSize * maximumCompressionRatio + 1024) formatCorrupt();
    totalExpanded += expandedSize;

    if (u32(bytes, localOffset) !== 0x04034b50) formatCorrupt();
    const localFlags = u16(bytes, localOffset + 6);
    const localMethod = u16(bytes, localOffset + 8);
    const localCrc = u32(bytes, localOffset + 14);
    const localCompressedSize = u32(bytes, localOffset + 18);
    const localExpandedSize = u32(bytes, localOffset + 22);
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    checkedRange(bytes, localOffset + 30, localNameLength + localExtraLength);
    if (
      localFlags !== flags || localMethod !== method || localCrc !== expectedCrc
      || localCompressedSize !== compressedSize || localExpandedSize !== expandedSize
    ) formatCorrupt();
    if (!bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) formatCorrupt();
    assertSupportedLocalExtra(bytes.subarray(localOffset + 30 + localNameLength, localOffset + 30 + localNameLength + localExtraLength));
    const compressedStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressedEnd = compressedStart + compressedSize;
    if (compressedEnd > centralOffset) formatCorrupt();
    localRanges.push([localOffset, compressedEnd]);
    const compressed = bytes.subarray(compressedStart, compressedEnd);
    let contents: Buffer;
    try {
      contents = method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: maximumEntryBytes });
    } catch {
      return formatCorrupt();
    }
    if (contents.length !== expandedSize || crc32(contents) !== expectedCrc) formatCorrupt();
    entries.push(Object.freeze({ name, method, contents }));
    cursor += recordLength;
  }
  if (cursor !== centralOffset + centralSize) formatCorrupt();
  localRanges.sort(([left], [right]) => left - right);
  if (localRanges[0]?.[0] !== 0 || localRanges.at(-1)?.[1] !== centralOffset) formatCorrupt();
  for (let index = 1; index < localRanges.length; index += 1) {
    if ((localRanges[index - 1]?.[1] ?? 0) !== (localRanges[index]?.[0] ?? -1)) formatCorrupt();
  }
  return Object.freeze(entries);
}

function writeZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = entry.method === 0 ? entry.contents : deflateRawSync(entry.contents, { level: 6 });
    const checksum = crc32(entry.contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly attributeRegions: Readonly<Record<string, XmlAttributeRegion>>;
  readonly parent?: string;
  readonly openingStart: number;
  readonly openingEnd: number;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

interface XmlAttributeRegion {
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly quote: '"' | "'";
}

function isXml10CodePoint(codePoint: number): boolean {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function isXml10String(value: string): boolean {
  for (const character of value) if (!isXml10CodePoint(character.codePointAt(0) ?? 0)) return false;
  return true;
}

function decodeXml(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#x[0-9A-Fa-f]+|#[0-9]+);)/u.test(value)) formatCorrupt();
  return value.replace(/&(?:amp|lt|gt|quot|apos|#x[0-9A-Fa-f]+|#[0-9]+);/gu, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const codePoint = entity.startsWith('&#x')
      ? Number.parseInt(entity.slice(3, -1), 16)
      : Number.parseInt(entity.slice(2, -1), 10);
    if (!Number.isSafeInteger(codePoint) || !isXml10CodePoint(codePoint)) formatCorrupt();
    return String.fromCodePoint(codePoint);
  });
}

function parseAttributes(source: string, rawBase: number): {
  readonly attributes: Readonly<Record<string, string>>;
  readonly regions: Readonly<Record<string, XmlAttributeRegion>>;
} {
  const attributes: Record<string, string> = {};
  const regions: Record<string, XmlAttributeRegion> = {};
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    if (cursor === source.length) break;
    const match = /^[A-Za-z_][A-Za-z0-9_.:-]*/u.exec(source.slice(cursor));
    if (match === null) formatCorrupt();
    const name = match[0];
    cursor += name.length;
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== '=') formatCorrupt();
    cursor += 1;
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") formatCorrupt();
    cursor += 1;
    const end = source.indexOf(quote, cursor);
    if (end < 0) formatCorrupt();
    if (Object.hasOwn(attributes, name)) formatCorrupt();
    if (Object.keys(attributes).length >= maximumXmlAttributes) formatCorrupt();
    attributes[name] = decodeXml(source.slice(cursor, end));
    regions[name] = Object.freeze({ rawStart: rawBase + cursor, rawEnd: rawBase + end, quote });
    cursor = end + 1;
  }
  return { attributes: Object.freeze(attributes), regions: Object.freeze(regions) };
}

function scanXml(xml: string, textElements: ReadonlySet<string> = new Set(['w:t'])): readonly XmlElement[] {
  if (!isXml10String(xml) || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/iu.test(xml)) formatCorrupt();
  const elements: XmlElement[] = [];
  const stack: string[] = [];
  let cursor = 0;
  let sawDeclaration = false;
  let rootElementCount = 0;
  while (cursor < xml.length) {
    const openingStart = xml.indexOf('<', cursor);
    if (openingStart < 0) {
      if (xml.slice(cursor).trim().length > 0) formatCorrupt();
      break;
    }
    if (xml.slice(cursor, openingStart).trim().length > 0) {
      const top = stack.at(-1);
      if (top === undefined || !textElements.has(top)) featureUnsupported('unknown_feature');
    }
    if (xml.startsWith('<!--', openingStart)) featureUnsupported();
    if (xml.startsWith('<?', openingStart)) {
      const end = xml.indexOf('?>', openingStart + 2);
      if (end < 0) formatCorrupt();
      const declaration = xml.slice(openingStart, end + 2);
      if (
        sawDeclaration
        || openingStart !== 0
        || !/^<\?xml[ \t\r\n]+version=(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding=(?:"(?:UTF-8|utf-8)"|'(?:UTF-8|utf-8)'))?(?:[ \t\r\n]+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>$/u.test(declaration)
      ) featureUnsupported('unknown_feature');
      sawDeclaration = true;
      cursor = end + 2;
      continue;
    }
    let openingEnd = openingStart + 1;
    let quote: string | undefined;
    while (openingEnd < xml.length) {
      const character = xml[openingEnd];
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      openingEnd += 1;
    }
    if (openingEnd >= xml.length) formatCorrupt();
    if (openingEnd - openingStart > maximumXmlTagCodeUnits) formatCorrupt();
    const raw = xml.slice(openingStart + 1, openingEnd);
    if (raw.startsWith('!')) formatCorrupt();
    const closing = raw.startsWith('/');
    const selfClosing = !closing && /\/\s*$/u.test(raw);
    const body = closing ? raw.slice(1).trim() : raw.replace(/\/\s*$/u, '').trim();
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/u.exec(body);
    if (nameMatch === null) formatCorrupt();
    const name = nameMatch[0];
    const parent = closing ? undefined : stack.at(-1);
    const bodyStart = openingStart + 1 + raw.indexOf(body);
    const parsedAttributes = closing
      ? { attributes: Object.freeze({}), regions: Object.freeze({}) }
      : parseAttributes(body.slice(name.length), bodyStart + name.length);
    if (closing) {
      if (body !== name || stack.pop() !== name) formatCorrupt();
    } else {
      if (stack.length === 0) {
        rootElementCount += 1;
        if (rootElementCount > 1) formatCorrupt();
      }
      if (!selfClosing) {
        if (stack.length >= maximumXmlDepth) formatCorrupt();
        stack.push(name);
      }
    }
    if (elements.length >= maximumXmlElements) formatCorrupt();
    elements.push(Object.freeze({
      name,
      attributes: parsedAttributes.attributes,
      attributeRegions: parsedAttributes.regions,
      ...(parent === undefined ? {} : { parent }),
      openingStart,
      openingEnd: openingEnd + 1,
      closing,
      selfClosing
    }));
    cursor = openingEnd + 1;
  }
  if (stack.length !== 0 || elements.length === 0 || rootElementCount !== 1) formatCorrupt();
  return Object.freeze(elements);
}

function decodeUtf8Xml(bytes: Buffer): string {
  try {
    const content = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return formatCorrupt();
  }
}

interface TextNodeRegion {
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly value: string;
  readonly preservesWhitespace: boolean;
}

interface SegmentRegion {
  readonly part: string;
  readonly paragraphNumber: number;
  readonly segmentNumber: number;
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly nodes: readonly TextNodeRegion[];
}

interface ParsedTextPart {
  readonly name: string;
  readonly segments: readonly SegmentRegion[];
}

interface ParsedDocxPackage {
  readonly canonicalText: string;
  readonly parts: readonly ParsedTextPart[];
  readonly segments: readonly SegmentRegion[];
  readonly carriers: readonly MappedXmlCarrierValue[];
  readonly canonicalRegions: readonly CanonicalRegion[];
  readonly extractionRevision: Sha256Digest;
}

/**
 * Privacy-safe evidence produced by the adapter-local DOCX reconciliation
 * foundation. This is deliberately not a release verification attestation:
 * it reuses the extraction parser and therefore cannot satisfy the independent
 * verifier boundary required by the application core.
 */
export interface DocxStageReconciliationFoundation {
  readonly outcome: 'RECONCILED_NONINDEPENDENT';
  readonly checks: readonly [
    'PLAN_AND_RECEIPT_BINDING',
    'WRITER_BYTE_REPRODUCTION',
    'ZIP_AND_OOXML_REOPEN',
    'CANONICAL_REPLACEMENT_RECONCILIATION',
    'QUALIFIED_CARRIER_RECONCILIATION',
    'UNTOUCHED_PART_CONTENT_IDENTITY',
    'UNIQUE_PLANNED_SOURCE_CANARY_SCAN'
  ];
  readonly expectedActionCount: number;
  readonly appliedActionCount: number;
  readonly retainedCarrierCount: number;
  readonly changedPartCount: number;
  readonly unchangedPartCount: number;
  readonly uniqueSourceCanaryCount: number;
  readonly independentlyVerified: false;
  readonly fidelityVerified: false;
}

interface XmlCarrierValue {
  readonly value: string;
  readonly location: DocxRelationshipLocationV2 | DocxXmlValueLocationV2;
  readonly part: string;
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly encoding: 'TEXT' | 'ATTRIBUTE';
  readonly quote?: '"' | "'";
}

interface MappedXmlCarrierValue extends XmlCarrierValue {
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
}

function carrierIdentity(carrier: XmlCarrierValue): string {
  const location = carrier.location;
  return location.kind === 'DOCX_RELATIONSHIP'
    ? `R\u0000${location.sourcePart}\u0000${location.relationshipId}`
    : `X\u0000${location.part}\u0000${location.element}\u0000${String(location.elementOrdinal).padStart(7, '0')}\u0000${location.carrier}\u0000${location.attribute ?? ''}`;
}

const blockedDocumentTags = new Set([
  'w:altChunk', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:br', 'w:commentRangeStart', 'w:commentRangeEnd',
  'w:commentReference', 'w:cr', 'w:customXml', 'w:del', 'w:delText', 'w:fldChar', 'w:fldSimple',
  'w:ins', 'w:instrText', 'w:moveFrom', 'w:moveFromRangeStart', 'w:moveFromRangeEnd',
  'w:moveTo', 'w:moveToRangeStart', 'w:moveToRangeEnd', 'w:noBreakHyphen', 'w:object', 'w:oleObject',
  'w:ptab', 'w:sdt', 'w:softHyphen', 'w:sym', 'w:txbxContent', 'w:vanish', 'w:webHidden', 'w:specVanish'
]);

const resumeTextElements = new Set([
  'w:document', 'w:hdr', 'w:ftr', 'w:footnotes', 'w:endnotes', 'w:body', 'w:p', 'w:pPr', 'w:r', 'w:rPr',
  'w:t', 'w:tab', 'w:sectPr', 'w:headerReference', 'w:footerReference', 'w:footnoteReference',
  'w:endnoteReference', 'w:separator', 'w:continuationSeparator', 'w:footnote', 'w:endnote', 'w:tbl', 'w:tblPr',
  'w:tblGrid', 'w:gridCol', 'w:tr', 'w:trPr', 'w:tc', 'w:tcPr', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:noProof',
  'w:pStyle', 'w:rStyle', 'w:rFonts', 'w:color', 'w:sz', 'w:szCs', 'w:u', 'w:spacing', 'w:ind', 'w:jc',
  'w:tabs', 'w:numPr', 'w:ilvl', 'w:numId', 'w:proofErr', 'w:pgSz', 'w:pgMar', 'w:cols', 'w:docGrid',
  'w:formProt', 'w:type', 'w:hyperlink', 'w:drawing', 'w:pict',
  'mc:AlternateContent', 'mc:Choice', 'mc:Fallback',
  'wp:anchor', 'wp:simplePos', 'wp:positionH', 'wp:positionV', 'wp:posOffset', 'wp:extent', 'wp:effectExtent',
  'wp:wrapNone', 'wp:docPr', 'wp:cNvGraphicFramePr', 'wp:align',
  'a:graphic', 'a:graphicData', 'a:solidFill', 'a:srgbClr', 'a:xfrm', 'a:off', 'a:ext', 'a:prstGeom',
  'a:avLst', 'a:ln', 'a:schemeClr', 'a:fillRef', 'a:lnRef', 'a:effectRef', 'a:fontRef',
  'wps:wsp', 'wps:cNvCnPr', 'wps:spPr', 'wps:style', 'wps:bodyPr',
  'v:fill', 'v:stroke', 'v:line', 'w10:wrap'
]);

const commonTextParents: Readonly<Record<string, readonly string[]>> = {
  'w:pPr': ['w:p'],
  'w:r': ['w:p', 'w:hyperlink'],
  'w:rPr': ['w:r', 'w:pPr'],
  'w:t': ['w:r'],
  'w:tab': ['w:r', 'w:tabs'],
  'w:footnoteReference': ['w:r'],
  'w:endnoteReference': ['w:r'],
  'w:separator': ['w:r'],
  'w:continuationSeparator': ['w:r'],
  'w:b': ['w:rPr'],
  'w:i': ['w:rPr'],
  'w:tblPr': ['w:tbl'],
  'w:tblGrid': ['w:tbl'],
  'w:gridCol': ['w:tblGrid'],
  'w:tr': ['w:tbl'],
  'w:trPr': ['w:tr'],
  'w:tc': ['w:tr'],
  'w:tcPr': ['w:tc']
};

interface TextPartDescriptor {
  readonly name: string;
  readonly root: 'w:document' | 'w:hdr' | 'w:ftr' | 'w:footnotes' | 'w:endnotes';
}

interface RawTextNode {
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly value: string;
  readonly preservesWhitespace: boolean;
}

interface RawSegment {
  readonly paragraphNumber: number;
  readonly segmentNumber: number;
  readonly nodes: readonly RawTextNode[];
}

interface ParsedTextPartRaw {
  readonly descriptor: TextPartDescriptor;
  readonly segments: readonly RawSegment[];
  readonly referencedHeaderFooterKinds: ReadonlyMap<string, 'header' | 'footer'>;
  readonly referencedFootnoteIds: ReadonlySet<number>;
  readonly referencedEndnoteIds: ReadonlySet<number>;
  readonly declaredNoteIds: ReadonlySet<number>;
  readonly referencedHyperlinkIds: ReadonlySet<string>;
  readonly carriers: readonly XmlCarrierValue[];
  readonly paragraphCount: number;
  readonly textNodeCount: number;
}

function validateDecorativeAlternateContent(elements: readonly XmlElement[]): void {
  const frames: { readonly name: string; readonly children: string[]; readonly attributes: Readonly<Record<string, string>> }[] = [];
  for (const element of elements) {
    if (!element.closing) {
      frames.at(-1)?.children.push(element.name);
      if (!element.selfClosing) frames.push({ name: element.name, children: [], attributes: element.attributes });
      continue;
    }
    const frame = frames.pop();
    if (frame?.name !== element.name) formatCorrupt();
    if (frame.name === 'mc:AlternateContent' && frame.children.join('\u0000') !== 'mc:Choice\u0000mc:Fallback') {
      featureUnsupported('drawing_or_alternate_content');
    }
    if (
      frame.name === 'mc:Choice'
      && (frame.children.join('\u0000') !== 'w:drawing' || Object.keys(frame.attributes).length !== 1 || frame.attributes.Requires !== 'wps')
    ) featureUnsupported('drawing_or_alternate_content');
    if (frame.name === 'mc:Fallback' && frame.children.join('\u0000') !== 'w:pict') featureUnsupported('drawing_or_alternate_content');
    if (frame.name === 'w:drawing' && frame.children.join('\u0000') !== 'wp:anchor') featureUnsupported('drawing_or_alternate_content');
    if (frame.name === 'w:pict' && (frame.children.length === 0 || frame.children.some((child) => !['v:fill', 'v:stroke', 'v:line', 'w10:wrap'].includes(child)))) {
      featureUnsupported('drawing_or_alternate_content');
    }
  }
  if (frames.length !== 0) formatCorrupt();
}

function allowedParentsFor(descriptor: TextPartDescriptor): Readonly<Record<string, readonly (string | undefined)[]>> {
  const contentParent = descriptor.root === 'w:document'
    ? 'w:body'
    : descriptor.root === 'w:footnotes'
      ? 'w:footnote'
      : descriptor.root === 'w:endnotes'
        ? 'w:endnote'
        : descriptor.root;
  return {
    [descriptor.root]: [undefined],
    ...commonTextParents,
    ...(descriptor.root === 'w:document' ? { 'w:body': ['w:document'], 'w:sectPr': ['w:body', 'w:pPr'], 'w:headerReference': ['w:sectPr'], 'w:footerReference': ['w:sectPr'] } : {}),
    ...(descriptor.root === 'w:footnotes' ? { 'w:footnote': ['w:footnotes'] } : {}),
    ...(descriptor.root === 'w:endnotes' ? { 'w:endnote': ['w:endnotes'] } : {}),
    'w:p': [contentParent, 'w:tc'],
    'w:tbl': [contentParent, 'w:tc'],
    'w:tr': ['w:tbl'],
    'w:tc': ['w:tr']
  };
}

function parseTextPart(bytes: Buffer, descriptor: TextPartDescriptor): ParsedTextPartRaw {
  const xml = decodeUtf8Xml(bytes);
  const structuralTextElements = new Set(['w:t', 'wp:posOffset', 'wp:align']);
  const elements = scanXml(xml, structuralTextElements);
  validateDecorativeAlternateContent(elements);
  const root = elements.find((element) => !element.closing);
  if (root?.name !== descriptor.root || root.attributes['xmlns:w'] !== wordNamespace) formatCorrupt();
  if (elements.some((element) => element.name === 'mc:AlternateContent') && root.attributes['xmlns:mc'] !== wordPassiveNamespaces.mc) {
    featureUnsupported('drawing_or_alternate_content');
  }
  const declaredNamespaces = validateRootNamespaces(root, ['w'], 'unknown_feature');
  const allowedParents = allowedParentsFor(descriptor);
  const referencedHeaderFooterKinds = new Map<string, 'header' | 'footer'>();
  const referencedFootnoteIds = new Set<number>();
  const referencedEndnoteIds = new Set<number>();
  const declaredNoteIds = new Set<number>();
  const referencedHyperlinkIds = new Set<string>();
  const specialNoteIds = new Set<number>();
  let activeSpecialNote: { readonly type: 'separator' | 'continuationSeparator'; markerSeen: boolean } | undefined;
  for (const element of elements) {
    if (blockedDocumentTags.has(element.name)) featureUnsupported('unknown_feature');
    const parents = allowedParents[element.name];
    if (!element.closing && element.name === 'w:t' && element.parent !== 'w:r') featureUnsupported('drawing_or_alternate_content');
    if (!resumeTextElements.has(element.name)) featureUnsupported('unknown_feature');
    if (parents !== undefined && !element.closing && !parents.includes(element.parent)) {
      featureUnsupported('unknown_feature');
    }
    if (!element.closing && element.name === 'w:r' && element.parent !== 'w:p' && element.parent !== 'w:hyperlink') featureUnsupported('unknown_feature');
    if (!element.closing && (element.name === 'w:drawing' || element.name === 'w:pict') && element.selfClosing) featureUnsupported('drawing_or_alternate_content');
    if (!element.closing && element.name === 'mc:Choice' && element.parent !== 'mc:AlternateContent') featureUnsupported('drawing_or_alternate_content');
    if (!element.closing && element.name === 'mc:Fallback' && element.parent !== 'mc:AlternateContent') featureUnsupported('drawing_or_alternate_content');
    if (!element.closing && element.name === 'mc:AlternateContent' && element.parent !== 'w:r') featureUnsupported('drawing_or_alternate_content');
    if (element.closing) {
      if (element.name === 'w:footnote' || element.name === 'w:endnote') {
        if (activeSpecialNote !== undefined && !activeSpecialNote.markerSeen) featureUnsupported('unknown_feature');
        activeSpecialNote = undefined;
      }
      continue;
    }
    const attributeEntries = Object.entries(element.attributes);
    const firstAttribute = attributeEntries[0];
    if (element.name === descriptor.root) {
      if (root.attributes['xmlns:r'] !== undefined && root.attributes['xmlns:r'] !== officeRelationshipNamespace) featureUnsupported('unknown_feature');
    } else if (element.name === 'w:p') {
      const allowed = new Set(['w14:paraId', 'w14:textId', 'w:rsidR', 'w:rsidRDefault', 'w:rsidP', 'w:rsidRPr']);
      if (attributeEntries.some(([name]) => !allowed.has(name))) featureUnsupported('unknown_feature');
    } else if (element.name === 'w:t') {
      if (activeSpecialNote !== undefined) featureUnsupported('unknown_feature');
      if (attributeEntries.length > 1 || (attributeEntries.length === 1 && (firstAttribute?.[0] !== 'xml:space' || firstAttribute[1] !== 'preserve'))) featureUnsupported('unknown_feature');
    } else if (element.name === 'w:tab') {
      if (!element.selfClosing || (element.parent === 'w:r' && attributeEntries.length > 0)) featureUnsupported('unknown_feature');
    } else if (element.name === 'w:footnoteReference' || element.name === 'w:endnoteReference') {
      if (descriptor.root !== 'w:document' || !element.selfClosing || attributeEntries.length !== 1 || !/^[1-9][0-9]{0,8}$/u.test(element.attributes['w:id'] ?? '')) {
        featureUnsupported('unknown_feature');
      }
      const id = Number(element.attributes['w:id']);
      (element.name === 'w:footnoteReference' ? referencedFootnoteIds : referencedEndnoteIds).add(id);
    } else if (element.name === 'w:separator' || element.name === 'w:continuationSeparator') {
      const expected = element.name === 'w:separator' ? 'separator' : 'continuationSeparator';
      if (!element.selfClosing || attributeEntries.length !== 0 || activeSpecialNote?.type !== expected || activeSpecialNote.markerSeen) featureUnsupported('unknown_feature');
      activeSpecialNote.markerSeen = true;
    } else if (element.name === 'w:headerReference' || element.name === 'w:footerReference') {
      if (
        !element.selfClosing || attributeEntries.length !== 2
        || !/^rId[1-9][0-9]{0,5}$/u.test(element.attributes['r:id'] ?? '')
        || !['default', 'first', 'even'].includes(element.attributes['w:type'] ?? '')
        || root.attributes['xmlns:r'] !== officeRelationshipNamespace
      ) featureUnsupported('unknown_feature');
      const id = element.attributes['r:id'] ?? '';
      const kind = element.name === 'w:headerReference' ? 'header' : 'footer';
      const priorKind = referencedHeaderFooterKinds.get(id);
      if (priorKind !== undefined && priorKind !== kind) formatCorrupt();
      referencedHeaderFooterKinds.set(id, kind);
    } else if (element.name === 'w:hyperlink') {
      if (
        element.parent !== 'w:p' || attributeEntries.length !== 1
        || !/^rId[1-9][0-9]{0,5}$/u.test(element.attributes['r:id'] ?? '')
        || root.attributes['xmlns:r'] !== officeRelationshipNamespace
      ) featureUnsupported('external_relationship');
      referencedHyperlinkIds.add(element.attributes['r:id'] ?? '');
    } else if (element.name === 'w:footnote' || element.name === 'w:endnote') {
      if (
        attributeEntries.length < 1 || attributeEntries.length > 2
        || !/^-?[0-9]{1,9}$/u.test(element.attributes['w:id'] ?? '')
        || (element.attributes['w:type'] !== undefined && !['separator', 'continuationSeparator'].includes(element.attributes['w:type']))
        || attributeEntries.some(([name]) => name !== 'w:id' && name !== 'w:type')
      ) featureUnsupported('unknown_feature');
      const id = Number(element.attributes['w:id']);
      const noteType = element.attributes['w:type'];
      if (noteType !== undefined) {
        if (element.selfClosing || id > 0 || specialNoteIds.has(id)) featureUnsupported('unknown_feature');
        specialNoteIds.add(id);
        activeSpecialNote = { type: noteType as 'separator' | 'continuationSeparator', markerSeen: false };
      } else {
        if (id < 1 || declaredNoteIds.has(id)) formatCorrupt();
        declaredNoteIds.add(id);
      }
    }
  }

  const provisional: RawSegment[] = [];
  let paragraphNumber = 0;
  let currentSegments: RawTextNode[][] | undefined;
  let textOpening: XmlElement | undefined;
  let textNodeCount = 0;
  for (const element of elements) {
    if (!element.closing && element.name === 'w:p') {
      if (currentSegments !== undefined) formatCorrupt();
      paragraphNumber += 1;
      if (paragraphNumber > maximumParagraphs) formatCorrupt();
      currentSegments = [[]];
    } else if (element.closing && element.name === 'w:p') {
      if (currentSegments === undefined || textOpening !== undefined) formatCorrupt();
      const nonempty = currentSegments.filter((nodes) => nodes.length > 0);
      for (const [segmentIndex, nodes] of nonempty.entries()) {
        provisional.push(Object.freeze({ paragraphNumber, segmentNumber: segmentIndex + 1, nodes: Object.freeze(nodes) }));
      }
      currentSegments = undefined;
    } else if (!element.closing && ((element.name === 'w:tab' && element.parent === 'w:r') || element.name === 'w:footnoteReference' || element.name === 'w:endnoteReference')) {
      if (currentSegments === undefined) formatCorrupt();
      if ((currentSegments.at(-1)?.length ?? 0) > 0) currentSegments.push([]);
    } else if (!element.closing && element.name === 'w:t') {
      if (currentSegments === undefined || textOpening !== undefined || element.selfClosing) formatCorrupt();
      textOpening = element;
    } else if (element.closing && element.name === 'w:t') {
      if (textOpening === undefined || currentSegments === undefined) formatCorrupt();
      if (textNodeCount >= maximumTextNodes) formatCorrupt();
      const rawStart = textOpening.openingEnd;
      const rawEnd = element.openingStart;
      const rawValue = xml.slice(rawStart, rawEnd);
      if (rawValue.includes('<')) formatCorrupt();
      const value = decodeXml(rawValue);
      if (value.length > 0) {
        currentSegments.at(-1)?.push({
          rawStart,
          rawEnd,
          value,
          preservesWhitespace: textOpening.attributes['xml:space'] === 'preserve'
        });
      }
      textNodeCount += 1;
      textOpening = undefined;
    }
  }
  if (currentSegments !== undefined || textOpening !== undefined || activeSpecialNote !== undefined) formatCorrupt();
  return {
    descriptor,
    segments: Object.freeze(provisional),
    referencedHeaderFooterKinds,
    referencedFootnoteIds,
    referencedEndnoteIds,
    declaredNoteIds,
    referencedHyperlinkIds,
    carriers: Object.freeze([
      ...collectXmlAttributeCarriers(descriptor.name, elements, declaredNamespaces),
      ...collectXmlTextCarriers(descriptor.name, xml, elements, new Set(['wp:posOffset', 'wp:align']))
    ]),
    paragraphCount: paragraphNumber,
    textNodeCount
  };
}

function assembleTextParts(parts: readonly ParsedTextPartRaw[], carriers: readonly XmlCarrierValue[]): ParsedDocxPackage {
  if (parts.reduce((total, part) => total + part.paragraphCount, 0) > maximumParagraphs) formatCorrupt();
  if (parts.reduce((total, part) => total + part.textNodeCount, 0) > maximumTextNodes) formatCorrupt();
  const canonicalParts: string[] = [];
  const parsedParts: ParsedTextPart[] = [];
  const segments: SegmentRegion[] = [];
  const mappedCarriers: MappedXmlCarrierValue[] = [];
  const canonicalRegions: CanonicalRegion[] = [];
  let canonicalLength = 0;
  const hash = createHash('sha256').update('local-pii:docx-extraction:v3\u0000', 'utf8');
  for (const part of parts) {
    const partSegments: SegmentRegion[] = [];
    hash.update(`PART:${part.descriptor.name}\u0000`, 'utf8');
    for (const segment of part.segments) {
      if (segments.length > 0) {
        canonicalParts.push(paragraphBoundary);
        canonicalLength += unicodeCodePointLength(paragraphBoundary);
      }
      const segmentStart = canonicalLength;
      hash.update(`S:${String(segment.paragraphNumber)}:${String(segment.segmentNumber)}:`, 'utf8');
      const nodes: TextNodeRegion[] = [];
      for (const value of segment.nodes) {
        const canonicalStart = canonicalLength;
        canonicalLength += unicodeCodePointLength(value.value);
        if (canonicalLength > maximumCanonicalCodePoints) formatCorrupt();
        canonicalParts.push(value.value);
        nodes.push(Object.freeze({ ...value, canonicalStart, canonicalEnd: canonicalLength }));
        hash.update('N:', 'utf8').update(String(Buffer.byteLength(value.value, 'utf8')), 'utf8').update(':', 'utf8').update(value.value, 'utf8');
      }
      const mapped = Object.freeze({
        part: part.descriptor.name,
        paragraphNumber: segment.paragraphNumber,
        segmentNumber: segment.segmentNumber,
        canonicalStart: segmentStart,
        canonicalEnd: canonicalLength,
        nodes: Object.freeze(nodes)
      });
      partSegments.push(mapped);
      segments.push(mapped);
      canonicalRegions.push(Object.freeze({
        schemaVersion: carriers.length === 0 ? '1.0.0' : '2.0.0',
        start: mapped.canonicalStart,
        end: mapped.canonicalEnd,
        offsetUnit: 'UNICODE_CODE_POINT',
        role: 'VALUE',
        location: Object.freeze({
          schemaVersion: '1.0.0',
          kind: 'DOCX_PART',
          part: mapped.part,
          paragraph: mapped.paragraphNumber
        })
      }));
    }
    parsedParts.push(Object.freeze({ name: part.descriptor.name, segments: Object.freeze(partSegments) }));
  }
  if (carriers.length > maximumCanonicalCarriers) formatCorrupt();
  for (const carrier of carriers) {
    if (carrier.value.length === 0) continue;
    if (canonicalParts.length > 0) {
      canonicalParts.push(carrierBoundary);
      canonicalLength += unicodeCodePointLength(carrierBoundary);
    }
    const start = canonicalLength;
    canonicalLength += unicodeCodePointLength(carrier.value);
    if (canonicalLength > maximumCanonicalCodePoints) formatCorrupt();
    canonicalParts.push(carrier.value);
    mappedCarriers.push(Object.freeze({ ...carrier, canonicalStart: start, canonicalEnd: canonicalLength }));
    canonicalRegions.push(Object.freeze({
      schemaVersion: '2.0.0',
      start,
      end: canonicalLength,
      offsetUnit: 'UNICODE_CODE_POINT',
      role: 'VALUE',
      location: Object.freeze(carrier.location)
    }));
    hash.update('C:', 'utf8')
      .update(carrier.location.kind, 'utf8')
      .update(':', 'utf8')
      .update(String(Buffer.byteLength(carrier.value, 'utf8')), 'utf8')
      .update(':', 'utf8')
      .update(carrier.value, 'utf8');
  }
  return {
    canonicalText: canonicalParts.join(''),
    parts: Object.freeze(parsedParts),
    segments: Object.freeze(segments),
    carriers: Object.freeze(mappedCarriers),
    canonicalRegions: Object.freeze(canonicalRegions),
    extractionRevision: parseSha256Digest(`sha256:${hash.digest('hex')}`)
  };
}

function elementsByName(xml: string, expectedRoot: string): readonly XmlElement[] {
  const elements = scanXml(xml);
  const root = elements.find((element) => !element.closing);
  if (root?.name !== expectedRoot) formatCorrupt();
  return elements;
}

interface PassiveElementRule {
  readonly parents: readonly (string | undefined)[];
  readonly attributes: readonly string[];
  readonly requiredAttributes?: readonly string[];
}

interface PassivePartProfile {
  readonly root: string;
  readonly namespaces: Readonly<Record<string, string>>;
  readonly elements: Readonly<Record<string, PassiveElementRule>>;
  readonly maximumCounts?: Readonly<Record<string, number>>;
  readonly requiredCounts?: Readonly<Record<string, number>>;
}

const wordPassiveNamespaces = Object.freeze({
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  wpc: 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas',
  cx: 'http://schemas.microsoft.com/office/drawing/2014/chartex',
  cx1: 'http://schemas.microsoft.com/office/drawing/2015/9/8/chartex',
  cx2: 'http://schemas.microsoft.com/office/drawing/2015/10/21/chartex',
  cx3: 'http://schemas.microsoft.com/office/drawing/2016/5/9/chartex',
  cx4: 'http://schemas.microsoft.com/office/drawing/2016/5/10/chartex',
  cx5: 'http://schemas.microsoft.com/office/drawing/2016/5/11/chartex',
  cx6: 'http://schemas.microsoft.com/office/drawing/2016/5/12/chartex',
  cx7: 'http://schemas.microsoft.com/office/drawing/2016/5/13/chartex',
  cx8: 'http://schemas.microsoft.com/office/drawing/2016/5/14/chartex',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  aink: 'http://schemas.microsoft.com/office/drawing/2016/ink',
  am3d: 'http://schemas.microsoft.com/office/drawing/2017/model3d',
  oel: 'http://schemas.microsoft.com/office/2019/extlst',
  r: officeRelationshipNamespace,
  wp14: 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  wpg: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  wpi: 'http://schemas.microsoft.com/office/word/2010/wordprocessingInk',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  sl: 'http://schemas.openxmlformats.org/schemaLibrary/2006/main',
  o: 'urn:schemas-microsoft-com:office:office',
  v: 'urn:schemas-microsoft-com:vml',
  w10: 'urn:schemas-microsoft-com:office:word',
  w: wordNamespace,
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  w16cei: 'http://schemas.microsoft.com/office/word/2026/wordml/cei',
  w16cex: 'http://schemas.microsoft.com/office/word/2018/wordml/cex',
  w16cid: 'http://schemas.microsoft.com/office/word/2016/wordml/cid',
  w16: 'http://schemas.microsoft.com/office/word/2018/wordml',
  w16sdtdh: 'http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash',
  w16sdtfl: 'http://schemas.microsoft.com/office/word/2024/wordml/sdtformatlock',
  w16se: 'http://schemas.microsoft.com/office/word/2015/wordml/symex',
  w16du: 'http://schemas.microsoft.com/office/word/2023/wordml/word16du',
  wne: 'http://schemas.microsoft.com/office/word/2006/wordml'
});

const wordCompatibilityNamespaces = Object.freeze(Object.fromEntries(
  ['mc', 'r', 'w', 'w14', 'w15', 'w16cex', 'w16cid', 'w16', 'w16sdtdh', 'w16sdtfl', 'w16se', 'w16du']
    .map((prefix) => [prefix, wordPassiveNamespaces[prefix as keyof typeof wordPassiveNamespaces]])
));

const themeElements: Readonly<Record<string, PassiveElementRule>> = Object.freeze({
  'a:theme': { parents: [undefined], attributes: ['name'] },
  'a:themeElements': { parents: ['a:theme'], attributes: [] },
  'a:clrScheme': { parents: ['a:themeElements'], attributes: ['name'] },
  ...Object.fromEntries(['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map((name) => [`a:${name}`, { parents: ['a:clrScheme'], attributes: [] }])),
  'a:srgbClr': { parents: ['a:dk1', 'a:lt1', 'a:dk2', 'a:lt2', 'a:accent1', 'a:accent2', 'a:accent3', 'a:accent4', 'a:accent5', 'a:accent6', 'a:hlink', 'a:folHlink'], attributes: ['val'] },
  'a:fontScheme': { parents: ['a:themeElements'], attributes: ['name'] },
  'a:majorFont': { parents: ['a:fontScheme'], attributes: [] },
  'a:minorFont': { parents: ['a:fontScheme'], attributes: [] },
  'a:latin': { parents: ['a:majorFont', 'a:minorFont'], attributes: ['typeface', 'panose'] },
  'a:ea': { parents: ['a:majorFont', 'a:minorFont'], attributes: ['typeface'] },
  'a:cs': { parents: ['a:majorFont', 'a:minorFont'], attributes: ['typeface'] },
  'a:fmtScheme': { parents: ['a:themeElements'], attributes: [] },
  'a:fillStyleLst': { parents: ['a:fmtScheme'], attributes: [] },
  'a:bgFillStyleLst': { parents: ['a:fmtScheme'], attributes: [] },
  'a:solidFill': { parents: ['a:fillStyleLst', 'a:bgFillStyleLst'], attributes: [] },
  'a:gradFill': { parents: ['a:fillStyleLst', 'a:bgFillStyleLst'], attributes: [] },
  'a:gsLst': { parents: ['a:gradFill'], attributes: [] },
  'a:gs': { parents: ['a:gsLst'], attributes: ['pos'] },
  'a:schemeClr': { parents: ['a:gs', 'a:solidFill'], attributes: ['val'] },
  'a:tint': { parents: ['a:schemeClr'], attributes: ['val'] },
  'a:shade': { parents: ['a:schemeClr'], attributes: ['val'] },
  'a:lumMod': { parents: ['a:schemeClr'], attributes: ['val'] },
  'a:lin': { parents: ['a:gradFill'], attributes: ['ang', 'scaled'] },
  'a:tileRect': { parents: ['a:gradFill'], attributes: [] },
  'a:lnStyleLst': { parents: ['a:fmtScheme'], attributes: [] },
  'a:ln': { parents: ['a:lnStyleLst'], attributes: ['w', 'cap', 'cmpd', 'algn'] },
  'a:prstDash': { parents: ['a:ln'], attributes: ['val'] },
  'a:miter': { parents: ['a:ln'], attributes: ['lim'] },
  'a:effectStyleLst': { parents: ['a:fmtScheme'], attributes: [] },
  'a:effectStyle': { parents: ['a:effectStyleLst'], attributes: [] },
  'a:effectLst': { parents: ['a:effectStyle'], attributes: [] },
  'a:objectDefaults': { parents: ['a:theme'], attributes: [] },
  'a:extraClrSchemeLst': { parents: ['a:theme'], attributes: [] }
});

const themeRequiredCounts = Object.freeze({
  'a:theme': 1, 'a:themeElements': 1, 'a:clrScheme': 1,
  'a:dk1': 1, 'a:lt1': 1, 'a:dk2': 1, 'a:lt2': 1,
  'a:accent1': 1, 'a:accent2': 1, 'a:accent3': 1, 'a:accent4': 1, 'a:accent5': 1, 'a:accent6': 1,
  'a:hlink': 1, 'a:folHlink': 1, 'a:srgbClr': 12,
  'a:fontScheme': 1, 'a:majorFont': 1, 'a:minorFont': 1, 'a:latin': 2, 'a:ea': 2, 'a:cs': 2,
  'a:fmtScheme': 1, 'a:fillStyleLst': 1, 'a:bgFillStyleLst': 1, 'a:solidFill': 3,
  'a:gradFill': 3, 'a:gsLst': 3, 'a:gs': 9, 'a:schemeClr': 12, 'a:tint': 7,
  'a:shade': 5, 'a:lumMod': 8, 'a:lin': 3, 'a:tileRect': 3,
  'a:lnStyleLst': 1, 'a:ln': 3, 'a:prstDash': 3, 'a:miter': 3,
  'a:effectStyleLst': 1, 'a:effectStyle': 3, 'a:effectLst': 3,
  'a:objectDefaults': 1, 'a:extraClrSchemeLst': 1
});

const passivePartProfiles: Readonly<Record<string, PassivePartProfile>> = Object.freeze({
  'word/webSettings.xml': {
    root: 'w:webSettings', namespaces: wordCompatibilityNamespaces,
    elements: { 'w:webSettings': { parents: [undefined], attributes: ['mc:Ignorable'] } },
    requiredCounts: { 'w:webSettings': 1 }, maximumCounts: { 'w:webSettings': 1 }
  },
  'word/theme/theme1.xml': {
    root: 'a:theme', namespaces: { a: 'http://schemas.openxmlformats.org/drawingml/2006/main' }, elements: themeElements,
    requiredCounts: themeRequiredCounts, maximumCounts: themeRequiredCounts
  },
});

const safeThemeNames = new Set(['Office', 'Office Theme']);
const safeTypefaceNames = new Set([
  '', 'Arial', 'Arial Black', 'Aptos', 'Aptos Display', 'Aptos Narrow', 'Calibri', 'Calibri Light',
  'Cambria', 'Courier New', 'Georgia', 'MS Mincho', 'Symbol', 'Tahoma', 'Times New Roman',
  'Trebuchet MS', 'Verdana', 'Wingdings'
]);
const safeSchemeColors = new Set(['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'bg1', 'bg2', 'dk1', 'dk2', 'folHlink', 'hlink', 'lt1', 'lt2', 'phClr', 'tx1', 'tx2']);

function passiveAttributeValueAllowed(part: string, element: string, name: string, value: string, namespaces: ReadonlyMap<string, string>): boolean {
  if (name === 'mc:Ignorable') {
    const tokens = value.split(' ');
    return tokens.length > 0 && new Set(tokens).size === tokens.length
      && tokens.every((token) => token.length > 0 && token !== 'mc' && token !== 'r' && token !== 'w' && namespaces.has(token));
  }
  if (part !== 'word/theme/theme1.xml') return false;
  if (name === 'name') return safeThemeNames.has(value);
  if (name === 'typeface') return safeTypefaceNames.has(value);
  if (name === 'panose') return /^[0-9A-Fa-f]{20}$/u.test(value);
  if (name === 'val') {
    if (element === 'a:srgbClr') return /^[0-9A-Fa-f]{6}$/u.test(value);
    if (element === 'a:schemeClr') return safeSchemeColors.has(value);
    if (element === 'a:prstDash') return ['solid', 'dash', 'dot', 'dashDot', 'lgDash', 'lgDashDot', 'lgDashDotDot', 'sysDash', 'sysDot'].includes(value);
    return /^(?:0|[1-9][0-9]{0,5})$/u.test(value);
  }
  if (name === 'scaled') return value === '0' || value === '1' || value === 'false' || value === 'true';
  if (name === 'cap') return value === 'flat' || value === 'rnd' || value === 'sq';
  if (name === 'cmpd') return ['sng', 'dbl', 'thickThin', 'thinThick', 'tri'].includes(value);
  if (name === 'algn') return value === 'ctr' || value === 'in';
  return /^(?:0|[1-9][0-9]{0,8})$/u.test(value);
}

function validatePassivePart(entry: ZipEntry, profile: PassivePartProfile): void {
  const elements = scanXml(decodeUtf8Xml(entry.contents));
  const root = elements.find((element) => !element.closing);
  if (root?.name !== profile.root) formatCorrupt();
  const declaredNamespaces = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const element of elements) {
    const rule = profile.elements[element.name];
    if (rule === undefined || (!element.closing && !rule.parents.includes(element.parent))) featureUnsupported('metadata_part');
    if (element.closing) continue;
    counts.set(element.name, (counts.get(element.name) ?? 0) + 1);
    const ordinaryAttributes: string[] = [];
    for (const [name, value] of Object.entries(element.attributes)) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        if (element !== root) featureUnsupported('metadata_part');
        const prefix = name === 'xmlns' ? '' : name.slice('xmlns:'.length);
        if (profile.namespaces[prefix] !== value || declaredNamespaces.has(prefix)) featureUnsupported('metadata_part');
        declaredNamespaces.set(prefix, value);
      } else {
        ordinaryAttributes.push(name);
        if (!rule.attributes.includes(name) || unicodeCodePointLength(value) > 512) featureUnsupported('metadata_part');
      }
    }
    const required = rule.requiredAttributes ?? rule.attributes;
    if (required.some((name) => !ordinaryAttributes.includes(name))) featureUnsupported('metadata_part');
  }
  for (const [prefix, uri] of Object.entries(profile.namespaces)) {
    if (declaredNamespaces.get(prefix) !== uri) featureUnsupported('metadata_part');
  }
  for (const element of elements) {
    if (element.closing) continue;
    for (const [name, value] of Object.entries(element.attributes)) {
      if (name !== 'xmlns' && !name.startsWith('xmlns:') && !passiveAttributeValueAllowed(entry.name, element.name, name, value, declaredNamespaces)) {
        featureUnsupported('metadata_part');
      }
    }
  }
  for (const [name, count] of Object.entries(profile.requiredCounts ?? {})) if (counts.get(name) !== count) featureUnsupported('metadata_part');
  for (const [name, count] of counts) if (count > (profile.maximumCounts?.[name] ?? 1)) featureUnsupported('metadata_part');
  if (entry.name === 'word/theme/theme1.xml') {
    const children = (parent: string) => elements.filter((element) => !element.closing && element.parent === parent).map((element) => element.name);
    if (children('a:theme').join('\u0000') !== ['a:themeElements', 'a:objectDefaults', 'a:extraClrSchemeLst'].join('\u0000')) featureUnsupported('metadata_part');
    if (children('a:themeElements').join('\u0000') !== ['a:clrScheme', 'a:fontScheme', 'a:fmtScheme'].join('\u0000')) featureUnsupported('metadata_part');
    if (children('a:clrScheme').join('\u0000') !== ['a:dk1', 'a:lt1', 'a:dk2', 'a:lt2', 'a:accent1', 'a:accent2', 'a:accent3', 'a:accent4', 'a:accent5', 'a:accent6', 'a:hlink', 'a:folHlink'].join('\u0000')) featureUnsupported('metadata_part');
    if (children('a:fontScheme').join('\u0000') !== ['a:majorFont', 'a:minorFont'].join('\u0000')) featureUnsupported('metadata_part');
    if (children('a:fmtScheme').join('\u0000') !== ['a:fillStyleLst', 'a:lnStyleLst', 'a:effectStyleLst', 'a:bgFillStyleLst'].join('\u0000')) featureUnsupported('metadata_part');
  }
}

type StructuralAttributeValidator = (value: string) => boolean;

const structuralPair = (element: string, attribute: string): string => `${element}\u0000${attribute}`;
const exactStructuralValues = (...values: readonly string[]): StructuralAttributeValidator => {
  const allowed = new Set(values);
  return (value) => allowed.has(value);
};
const boundedUnsignedDecimal = (maximum: number, minimum = 0): StructuralAttributeValidator => (value) => {
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum;
};
const boundedSignedDecimal = (absoluteMaximum: number): StructuralAttributeValidator => (value) => {
  if (!/^-?(?:0|[1-9][0-9]{0,9})$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && Math.abs(parsed) <= absoluteMaximum;
};
const exactHex = (length: number): StructuralAttributeValidator => {
  const pattern = new RegExp(`^[0-9A-Fa-f]{${String(length)}}$`, 'u');
  return (value) => pattern.test(value);
};

const relationshipId = (value: string): boolean => /^rId[1-9][0-9]{0,5}$/u.test(value);
const hex8 = exactHex(8);
const unsignedInt32 = boundedUnsignedDecimal(4_294_967_295);
const positiveInt32 = boundedUnsignedDecimal(2_147_483_647, 1);
const unsignedInt31 = boundedUnsignedDecimal(2_147_483_647);
const signedInt31 = boundedSignedDecimal(2_147_483_647);
const onOff = exactStructuralValues('0', '1', 'true', 'false', 'on', 'off');
const noteType = exactStructuralValues('separator', 'continuationSeparator');
const headerFooterType = exactStructuralValues('default', 'first', 'even');
const numberFormat = exactStructuralValues('none', 'decimal', 'bullet', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman');
const tabAlignment = exactStructuralValues('bar', 'center', 'clear', 'decimal', 'end', 'left', 'num', 'right', 'start');
const color = (value: string): boolean => value === 'auto' || exactHex(6)(value);

const closedStructuralAttributeValidators: Readonly<Record<string, StructuralAttributeValidator>> = Object.freeze({
  [structuralPair('w:t', 'xml:space')]: exactStructuralValues('preserve'),
  [structuralPair('w:headerReference', 'r:id')]: relationshipId,
  [structuralPair('w:headerReference', 'w:type')]: headerFooterType,
  [structuralPair('w:footerReference', 'r:id')]: relationshipId,
  [structuralPair('w:footerReference', 'w:type')]: headerFooterType,
  [structuralPair('w:hyperlink', 'r:id')]: relationshipId,
  [structuralPair('w:footnoteReference', 'w:id')]: positiveInt32,
  [structuralPair('w:endnoteReference', 'w:id')]: positiveInt32,
  [structuralPair('w:footnote', 'w:id')]: boundedSignedDecimal(999_999_999),
  [structuralPair('w:footnote', 'w:type')]: noteType,
  [structuralPair('w:endnote', 'w:id')]: boundedSignedDecimal(999_999_999),
  [structuralPair('w:endnote', 'w:type')]: noteType,
  [structuralPair('w:p', 'w14:paraId')]: hex8,
  [structuralPair('w:p', 'w14:textId')]: hex8,
  [structuralPair('w:p', 'w:rsidR')]: hex8,
  [structuralPair('w:p', 'w:rsidRDefault')]: hex8,
  [structuralPair('w:p', 'w:rsidP')]: hex8,
  [structuralPair('w:p', 'w:rsidRPr')]: hex8,
  [structuralPair('w:r', 'w:rsidR')]: hex8,
  [structuralPair('w:sectPr', 'w:rsidR')]: hex8,
  [structuralPair('w:rsid', 'w:val')]: hex8,
  [structuralPair('w:rsidRoot', 'w:val')]: hex8,
  [structuralPair('w:nsid', 'w:val')]: hex8,
  [structuralPair('w:tmpl', 'w:val')]: hex8,
  [structuralPair('w:num', 'w:numId')]: unsignedInt31,
  [structuralPair('w:num', 'w16cid:durableId')]: unsignedInt32,
  [structuralPair('w:abstractNum', 'w:abstractNumId')]: unsignedInt31,
  [structuralPair('w:abstractNum', 'w15:restartNumberingAfterBreak')]: onOff,
  [structuralPair('w:lvl', 'w:ilvl')]: boundedUnsignedDecimal(8),
  [structuralPair('w:start', 'w:val')]: unsignedInt31,
  [structuralPair('w:numFmt', 'w:val')]: numberFormat,
  [structuralPair('w:suff', 'w:val')]: exactStructuralValues('tab', 'space', 'nothing'),
  [structuralPair('w:lvlJc', 'w:val')]: exactStructuralValues('left', 'right', 'center', 'start', 'end'),
  [structuralPair('w:outlineLvl', 'w:val')]: boundedUnsignedDecimal(9),
  [structuralPair('w:uiPriority', 'w:val')]: boundedUnsignedDecimal(99),
  [structuralPair('w:sz', 'w:val')]: boundedUnsignedDecimal(1_638, 1),
  [structuralPair('w:szCs', 'w:val')]: boundedUnsignedDecimal(1_638, 1),
  [structuralPair('w:defaultTabStop', 'w:val')]: unsignedInt31,
  [structuralPair('w:hyphenationZone', 'w:val')]: unsignedInt31,
  [structuralPair('w:zoom', 'w:percent')]: boundedUnsignedDecimal(500),
  [structuralPair('w:ind', 'w:left')]: signedInt31,
  [structuralPair('w:ind', 'w:right')]: signedInt31,
  [structuralPair('w:ind', 'w:firstLine')]: signedInt31,
  [structuralPair('w:ind', 'w:hanging')]: signedInt31,
  [structuralPair('w:spacing', 'w:before')]: unsignedInt31,
  [structuralPair('w:spacing', 'w:after')]: unsignedInt31,
  [structuralPair('w:spacing', 'w:line')]: signedInt31,
  [structuralPair('w:spacing', 'w:lineRule')]: exactStructuralValues('auto', 'atLeast', 'exact'),
  [structuralPair('w:tab', 'w:pos')]: signedInt31,
  [structuralPair('w:tab', 'w:val')]: tabAlignment,
  [structuralPair('w:pgSz', 'w:w')]: positiveInt32,
  [structuralPair('w:pgSz', 'w:h')]: positiveInt32,
  [structuralPair('w:pgMar', 'w:top')]: signedInt31,
  [structuralPair('w:pgMar', 'w:right')]: signedInt31,
  [structuralPair('w:pgMar', 'w:bottom')]: signedInt31,
  [structuralPair('w:pgMar', 'w:left')]: signedInt31,
  [structuralPair('w:pgMar', 'w:header')]: unsignedInt31,
  [structuralPair('w:pgMar', 'w:footer')]: unsignedInt31,
  [structuralPair('w:pgMar', 'w:gutter')]: unsignedInt31,
  [structuralPair('w:docGrid', 'w:charSpace')]: signedInt31,
  [structuralPair('w:docGrid', 'w:linePitch')]: unsignedInt31,
  [structuralPair('w:cols', 'w:num')]: boundedUnsignedDecimal(45, 1),
  [structuralPair('w:cols', 'w:space')]: unsignedInt31,
  [structuralPair('w:panose1', 'w:val')]: exactHex(20),
  [structuralPair('w:sig', 'w:usb0')]: hex8,
  [structuralPair('w:sig', 'w:usb1')]: hex8,
  [structuralPair('w:sig', 'w:usb2')]: hex8,
  [structuralPair('w:sig', 'w:usb3')]: hex8,
  [structuralPair('w:sig', 'w:csb0')]: hex8,
  [structuralPair('w:sig', 'w:csb1')]: hex8,
  [structuralPair('w:color', 'w:val')]: color,
  [structuralPair('w:shd', 'w:fill')]: color,
  [structuralPair('wp:anchor', 'distT')]: unsignedInt32,
  [structuralPair('wp:anchor', 'distB')]: unsignedInt32,
  [structuralPair('wp:anchor', 'distL')]: unsignedInt32,
  [structuralPair('wp:anchor', 'distR')]: unsignedInt32,
  [structuralPair('wp:anchor', 'simplePos')]: onOff,
  [structuralPair('wp:anchor', 'relativeHeight')]: unsignedInt32,
  [structuralPair('wp:anchor', 'behindDoc')]: onOff,
  [structuralPair('wp:anchor', 'locked')]: onOff,
  [structuralPair('wp:anchor', 'layoutInCell')]: onOff,
  [structuralPair('wp:anchor', 'allowOverlap')]: onOff,
  [structuralPair('wp:anchor', 'wp14:anchorId')]: hex8,
  [structuralPair('wp:anchor', 'wp14:editId')]: hex8,
  [structuralPair('wp:simplePos', 'x')]: signedInt31,
  [structuralPair('wp:simplePos', 'y')]: signedInt31,
  [structuralPair('wp:extent', 'cx')]: unsignedInt32,
  [structuralPair('wp:extent', 'cy')]: unsignedInt32,
  [structuralPair('wp:effectExtent', 'l')]: signedInt31,
  [structuralPair('wp:effectExtent', 't')]: signedInt31,
  [structuralPair('wp:effectExtent', 'r')]: signedInt31,
  [structuralPair('wp:effectExtent', 'b')]: signedInt31,
  [structuralPair('wp:docPr', 'id')]: boundedUnsignedDecimal(4_294_967_295, 1),
  [structuralPair('a:off', 'x')]: signedInt31,
  [structuralPair('a:off', 'y')]: signedInt31,
  [structuralPair('a:ext', 'cx')]: unsignedInt32,
  [structuralPair('a:ext', 'cy')]: unsignedInt32,
  [structuralPair('a:ln', 'w')]: unsignedInt32,
  [structuralPair('a:fillRef', 'idx')]: boundedUnsignedDecimal(1_000),
  [structuralPair('a:lnRef', 'idx')]: boundedUnsignedDecimal(1_000),
  [structuralPair('a:effectRef', 'idx')]: boundedUnsignedDecimal(1_000),
  [structuralPair('a:fontRef', 'idx')]: exactStructuralValues('minor', 'major'),
  [structuralPair('a:prstGeom', 'prst')]: exactStructuralValues('line', 'rect'),
  [structuralPair('a:srgbClr', 'val')]: exactHex(6),
  [structuralPair('v:line', 'wp14:anchorId')]: hex8
});

function isClosedStructuralCarrierAttribute(part: string, element: string, name: string, value: string): boolean {
  if (part.startsWith('customXml/')) return false;
  const validator = closedStructuralAttributeValidators[structuralPair(element, name)];
  if (validator === undefined) return false;
  if (!validator(value)) {
    featureUnsupported(part === 'word/document.xml' || /^word\/(?:header|footer|footnotes|endnotes)/u.test(part) ? 'unknown_feature' : 'metadata_part');
  }
  return true;
}

function validateRootNamespaces(
  root: XmlElement,
  required: readonly string[],
  reason: UnsupportedFeatureReason = 'metadata_part'
): ReadonlySet<string> {
  const declared = new Set<string>();
  for (const [name, value] of Object.entries(root.attributes)) {
    if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
    const prefix = name === 'xmlns' ? '' : name.slice(6);
    if (prefix === '' || wordPassiveNamespaces[prefix as keyof typeof wordPassiveNamespaces] !== value || declared.has(prefix)) {
      featureUnsupported(reason);
    }
    declared.add(prefix);
  }
  for (const prefix of required) if (!declared.has(prefix)) featureUnsupported(reason);
  return declared;
}

function qnamePrefix(name: string): string | undefined {
  const separator = name.indexOf(':');
  return separator < 0 ? undefined : name.slice(0, separator);
}

const additionalCarrierNamespaces: Readonly<Partial<Record<string, string>>> = Object.freeze({
  b: 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography',
  ds: 'http://schemas.openxmlformats.org/officeDocument/2006/customXml',
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  dc: 'http://purl.org/dc/elements/1.1/', dcterms: 'http://purl.org/dc/terms/',
  dcmitype: 'http://purl.org/dc/dcmitype/', xsi: 'http://www.w3.org/2001/XMLSchema-instance'
});

function collectXmlAttributeCarriers(
  part: string,
  elements: readonly XmlElement[],
  declared: ReadonlySet<string>
): readonly XmlCarrierValue[] {
  const knownNamespaces = new Set(declared);
  for (const element of elements) {
    if (element.closing) continue;
    for (const [name, value] of Object.entries(element.attributes)) {
      if (!name.startsWith('xmlns:')) continue;
      const prefix = name.slice(6);
      const wordNamespaceUri = (wordPassiveNamespaces as Readonly<Partial<Record<string, string>>>)[prefix];
      const expected = wordNamespaceUri ?? additionalCarrierNamespaces[prefix];
      if (expected !== value) featureUnsupported('metadata_part');
      knownNamespaces.add(prefix);
    }
  }
  const ordinals = new Map<string, number>();
  const carriers: XmlCarrierValue[] = [];
  for (const element of elements) {
    if (element.closing) continue;
    const prefix = qnamePrefix(element.name);
    if (prefix !== undefined && !knownNamespaces.has(prefix)) featureUnsupported('metadata_part');
    const ordinal = (ordinals.get(element.name) ?? 0) + 1;
    ordinals.set(element.name, ordinal);
    for (const [name, value] of Object.entries(element.attributes)) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
      const attributePrefix = qnamePrefix(name);
      if (attributePrefix !== undefined && attributePrefix !== 'xml' && !knownNamespaces.has(attributePrefix)) featureUnsupported('metadata_part');
      if (unicodeCodePointLength(value) > maximumRelationshipTargetCodePoints) formatCorrupt();
      const structural = isClosedStructuralCarrierAttribute(part, element.name, name, value);
      if (structural) continue;
      const raw = element.attributeRegions[name];
      if (raw === undefined) formatCorrupt();
      carriers.push(Object.freeze({
        value,
        part,
        rawStart: raw.rawStart,
        rawEnd: raw.rawEnd,
        encoding: 'ATTRIBUTE',
        quote: raw.quote,
        location: Object.freeze({
          schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part, element: element.name,
          elementOrdinal: ordinal, carrier: 'ATTRIBUTE', attribute: name
        })
      }));
      if (carriers.length > maximumCanonicalCarriers) formatCorrupt();
    }
  }
  return Object.freeze(carriers);
}

function collectXmlTextCarriers(
  part: string,
  xml: string,
  elements: readonly XmlElement[],
  textElements: ReadonlySet<string>
): readonly XmlCarrierValue[] {
  const ordinals = new Map<string, number>();
  const stack: XmlElement[] = [];
  const carriers: XmlCarrierValue[] = [];
  for (const element of elements) {
    if (!element.closing) {
      ordinals.set(element.name, (ordinals.get(element.name) ?? 0) + 1);
      if (!element.selfClosing) stack.push(element);
      continue;
    }
    const opening = stack.pop();
    if (opening?.name !== element.name) formatCorrupt();
    if (!textElements.has(element.name)) continue;
    const raw = xml.slice(opening.openingEnd, element.openingStart);
    if (raw.includes('<')) formatCorrupt();
    const value = decodeXml(raw);
    if (unicodeCodePointLength(value) > maximumRelationshipTargetCodePoints) formatCorrupt();
    if (value.length > 0) carriers.push(Object.freeze({
      value,
      part,
      rawStart: opening.openingEnd,
      rawEnd: element.openingStart,
      encoding: 'TEXT',
      location: Object.freeze({
        schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part, element: element.name,
        elementOrdinal: ordinals.get(element.name) ?? 1, carrier: 'TEXT'
      })
    }));
  }
  if (stack.length !== 0) formatCorrupt();
  return Object.freeze(carriers);
}

const settingsElements = new Set([
  'w:settings', 'w:zoom', 'w:proofState', 'w:defaultTabStop', 'w:autoHyphenation', 'w:hyphenationZone',
  'w:characterSpacingControl', 'w:themeFontLang', 'w:clrSchemeMapping', 'w:compat', 'w:compatSetting', 'w:rsids',
  'w:rsidRoot', 'w:rsid', 'm:mathPr', 'm:mathFont', 'm:brkBin', 'm:brkBinSub', 'm:smallFrac', 'm:dispDef',
  'm:lMargin', 'm:rMargin', 'm:defJc', 'm:wrapIndent', 'm:intLim', 'm:naryLim', 'w:footnotePr', 'w:endnotePr',
  'w:footnote', 'w:endnote', 'w:decimalSymbol', 'w:listSeparator', 'w14:docId', 'w15:docId'
]);
const numberingElements = new Set([
  'w:numbering', 'w:abstractNum', 'w:nsid', 'w:multiLevelType', 'w:tmpl', 'w:lvl', 'w:start', 'w:numFmt',
  'w:suff', 'w:lvlText', 'w:lvlJc', 'w:pPr', 'w:tabs', 'w:tab', 'w:ind', 'w:rPr', 'w:rFonts', 'w:b',
  'w:bCs', 'w:num', 'w:abstractNumId'
]);
const stylesElements = new Set([
  'w:styles', 'w:docDefaults', 'w:rPrDefault', 'w:pPrDefault', 'w:rPr', 'w:pPr', 'w:latentStyles',
  'w:lsdException', 'w:style', 'w:name', 'w:basedOn', 'w:next', 'w:link', 'w:uiPriority', 'w:qFormat',
  'w:semiHidden', 'w:unhideWhenUsed', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:color', 'w:sz',
  'w:szCs', 'w:u', 'w:lang', 'w:keepNext', 'w:contextualSpacing', 'w:suppressAutoHyphens',
  'w:suppressLineNumbers', 'w:spacing', 'w:ind', 'w:outlineLvl', 'w:tabs', 'w:tab', 'w:tblPr', 'w:tblInd',
  'w:tblCellMar', 'w:top', 'w:left', 'w:bottom', 'w:right', 'w:shd', 'w:rsid'
]);
const fontTableElements = new Set([
  'w:fonts', 'w:font', 'w:altName', 'w:charset', 'w:family', 'w:notTrueType', 'w:panose1', 'w:pitch', 'w:sig'
]);

function parents(entries: Readonly<Record<string, readonly string[]>>): ReadonlyMap<string, ReadonlySet<string | undefined>> {
  return new Map(Object.entries(entries).map(([parent, children]) => [parent, new Set(children.map((child) => child === '$root' ? undefined : child))]));
}

const settingsParents = parents({
  'w:settings': ['$root'],
  'w:zoom': ['w:settings'], 'w:proofState': ['w:settings'], 'w:defaultTabStop': ['w:settings'],
  'w:autoHyphenation': ['w:settings'], 'w:hyphenationZone': ['w:settings'], 'w:characterSpacingControl': ['w:settings'],
  'w:themeFontLang': ['w:settings'], 'w:clrSchemeMapping': ['w:settings'], 'w:compat': ['w:settings'],
  'w:compatSetting': ['w:compat'], 'w:rsids': ['w:settings'], 'w:rsidRoot': ['w:rsids'], 'w:rsid': ['w:rsids'],
  'm:mathPr': ['w:settings'], 'm:mathFont': ['m:mathPr'], 'm:brkBin': ['m:mathPr'], 'm:brkBinSub': ['m:mathPr'],
  'm:smallFrac': ['m:mathPr'], 'm:dispDef': ['m:mathPr'], 'm:lMargin': ['m:mathPr'], 'm:rMargin': ['m:mathPr'],
  'm:defJc': ['m:mathPr'], 'm:wrapIndent': ['m:mathPr'], 'm:intLim': ['m:mathPr'], 'm:naryLim': ['m:mathPr'],
  'w:footnotePr': ['w:settings'], 'w:endnotePr': ['w:settings'], 'w:footnote': ['w:footnotePr'], 'w:endnote': ['w:endnotePr'],
  'w:decimalSymbol': ['w:settings'], 'w:listSeparator': ['w:settings'], 'w14:docId': ['w:settings'], 'w15:docId': ['w:settings']
});
const numberingParents = parents({
  'w:numbering': ['$root'], 'w:abstractNum': ['w:numbering'], 'w:num': ['w:numbering'],
  'w:nsid': ['w:abstractNum'], 'w:multiLevelType': ['w:abstractNum'], 'w:tmpl': ['w:abstractNum'], 'w:lvl': ['w:abstractNum'],
  'w:start': ['w:lvl'], 'w:numFmt': ['w:lvl'], 'w:suff': ['w:lvl'], 'w:lvlText': ['w:lvl'], 'w:lvlJc': ['w:lvl'],
  'w:pPr': ['w:lvl'], 'w:rPr': ['w:lvl'], 'w:tabs': ['w:pPr'], 'w:tab': ['w:tabs'], 'w:ind': ['w:pPr'],
  'w:rFonts': ['w:rPr'], 'w:b': ['w:rPr'], 'w:bCs': ['w:rPr'], 'w:abstractNumId': ['w:num']
});
const stylesParents = parents({
  'w:styles': ['$root'], 'w:docDefaults': ['w:styles'], 'w:latentStyles': ['w:styles'], 'w:style': ['w:styles'],
  'w:rPrDefault': ['w:docDefaults'], 'w:pPrDefault': ['w:docDefaults'], 'w:rPr': ['w:rPrDefault', 'w:style'],
  'w:pPr': ['w:pPrDefault', 'w:style'], 'w:lsdException': ['w:latentStyles'],
  'w:name': ['w:style'], 'w:basedOn': ['w:style'], 'w:next': ['w:style'], 'w:link': ['w:style'],
  'w:uiPriority': ['w:style'], 'w:qFormat': ['w:style'], 'w:semiHidden': ['w:style'], 'w:unhideWhenUsed': ['w:style'],
  'w:rFonts': ['w:rPr'], 'w:b': ['w:rPr'], 'w:bCs': ['w:rPr'], 'w:i': ['w:rPr'], 'w:iCs': ['w:rPr'],
  'w:color': ['w:rPr'], 'w:sz': ['w:rPr'], 'w:szCs': ['w:rPr'], 'w:u': ['w:rPr'], 'w:lang': ['w:rPr'],
  'w:keepNext': ['w:pPr'], 'w:contextualSpacing': ['w:pPr'], 'w:suppressAutoHyphens': ['w:pPr'],
  'w:suppressLineNumbers': ['w:pPr'], 'w:spacing': ['w:pPr'], 'w:ind': ['w:pPr'], 'w:outlineLvl': ['w:pPr'],
  'w:tabs': ['w:pPr'], 'w:tab': ['w:tabs'], 'w:tblPr': ['w:style'], 'w:tblInd': ['w:tblPr'],
  'w:tblCellMar': ['w:tblPr'], 'w:top': ['w:tblCellMar'], 'w:left': ['w:tblCellMar'],
  'w:bottom': ['w:tblCellMar'], 'w:right': ['w:tblCellMar'], 'w:shd': ['w:rPr'], 'w:rsid': ['w:pPr', 'w:rPr', 'w:style']
});
const fontTableParents = parents({
  'w:fonts': ['$root'], 'w:font': ['w:fonts'], 'w:altName': ['w:font'], 'w:charset': ['w:font'],
  'w:family': ['w:font'], 'w:notTrueType': ['w:font'], 'w:panose1': ['w:font'], 'w:pitch': ['w:font'], 'w:sig': ['w:font']
});
const settingsOrder = Object.freeze({
  'w:settings': ['w:zoom', 'w:proofState', 'w:defaultTabStop', 'w:autoHyphenation', 'w:hyphenationZone', 'w:characterSpacingControl', 'w:footnotePr', 'w:endnotePr', 'w:compat', 'w:rsids', 'm:mathPr', 'w:themeFontLang', 'w:clrSchemeMapping', 'w:decimalSymbol', 'w:listSeparator', 'w14:docId', 'w15:docId'],
  'w:compat': ['w:compatSetting'], 'w:rsids': ['w:rsidRoot', 'w:rsid'],
  'm:mathPr': ['m:mathFont', 'm:brkBin', 'm:brkBinSub', 'm:smallFrac', 'm:dispDef', 'm:lMargin', 'm:rMargin', 'm:defJc', 'm:wrapIndent', 'm:intLim', 'm:naryLim'],
  'w:footnotePr': ['w:footnote'], 'w:endnotePr': ['w:endnote']
});
const numberingOrder = Object.freeze({
  'w:numbering': ['w:abstractNum', 'w:num'], 'w:abstractNum': ['w:nsid', 'w:multiLevelType', 'w:tmpl', 'w:lvl'],
  'w:lvl': ['w:start', 'w:numFmt', 'w:suff', 'w:lvlText', 'w:lvlJc', 'w:pPr', 'w:rPr'],
  'w:pPr': ['w:tabs', 'w:ind'], 'w:tabs': ['w:tab'], 'w:rPr': ['w:rFonts', 'w:b', 'w:bCs'], 'w:num': ['w:abstractNumId']
});
const stylesOrder = Object.freeze({
  'w:styles': ['w:docDefaults', 'w:latentStyles', 'w:style'], 'w:docDefaults': ['w:rPrDefault', 'w:pPrDefault'],
  'w:rPrDefault': ['w:rPr'], 'w:pPrDefault': ['w:pPr'], 'w:latentStyles': ['w:lsdException'],
  'w:style': ['w:name', 'w:basedOn', 'w:next', 'w:link', 'w:uiPriority', 'w:semiHidden', 'w:unhideWhenUsed', 'w:qFormat', 'w:rsid', 'w:pPr', 'w:rPr', 'w:tblPr'],
  'w:pPr': ['w:suppressLineNumbers', 'w:suppressAutoHyphens', 'w:keepNext', 'w:tabs', 'w:spacing', 'w:ind', 'w:outlineLvl', 'w:contextualSpacing', 'w:rsid'],
  'w:tabs': ['w:tab'],
  'w:rPr': ['w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:color', 'w:sz', 'w:szCs', 'w:u', 'w:lang', 'w:shd', 'w:rsid'],
  'w:tblPr': ['w:tblInd', 'w:tblCellMar'], 'w:tblCellMar': ['w:top', 'w:left', 'w:bottom', 'w:right']
});
const fontTableOrder = Object.freeze({
  'w:fonts': ['w:font'], 'w:font': ['w:altName', 'w:panose1', 'w:charset', 'w:family', 'w:notTrueType', 'w:pitch', 'w:sig']
});

const requiredCarrierAttributes: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'w:compatSetting': ['w:name', 'w:uri', 'w:val'],
  'w:abstractNum': ['w:abstractNumId'], 'w:lvl': ['w:ilvl'], 'w:num': ['w:numId'],
  'w:lvlText': ['w:val'], 'w:style': ['w:type', 'w:styleId'], 'w:lsdException': ['w:name'], 'w:font': ['w:name']
});
const carrierChildCardinality: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> = Object.freeze({
  'w:abstractNum': { 'w:nsid': [1, 1], 'w:multiLevelType': [1, 1], 'w:tmpl': [1, 1], 'w:lvl': [1, 9] },
  'w:lvl': { 'w:start': [1, 1], 'w:numFmt': [1, 1], 'w:suff': [0, 1], 'w:lvlText': [1, 1], 'w:lvlJc': [1, 1], 'w:pPr': [1, 1], 'w:rPr': [0, 1] },
  'w:num': { 'w:abstractNumId': [1, 1] }, 'w:tabs': { 'w:tab': [1, 64] },
  'w:docDefaults': { 'w:rPrDefault': [1, 1], 'w:pPrDefault': [1, 1] },
  'w:rPrDefault': { 'w:rPr': [1, 1] }, 'w:pPrDefault': { 'w:pPr': [1, 1] },
  'w:style': { 'w:name': [1, 1], 'w:pPr': [0, 1], 'w:rPr': [0, 1], 'w:tblPr': [0, 1] },
  'w:font': { 'w:altName': [0, 1], 'w:panose1': [1, 1], 'w:charset': [1, 1], 'w:family': [1, 1], 'w:notTrueType': [0, 1], 'w:pitch': [1, 1], 'w:sig': [0, 1] }
});

function validateWordCarrierPart(
  entry: ZipEntry,
  rootName: string,
  allowed: ReadonlySet<string>,
  allowedParents: ReadonlyMap<string, ReadonlySet<string | undefined>>,
  childOrder: Readonly<Record<string, readonly string[]>>,
  maximumElements: number
): readonly XmlCarrierValue[] {
  const elements = scanXml(decodeUtf8Xml(entry.contents));
  const root = elements.find((element) => !element.closing);
  if (root?.name !== rootName) formatCorrupt();
  if (elements.filter((element) => !element.closing).length > maximumElements) formatCorrupt();
  const requiredNamespaces = [...new Set([...allowed].map(qnamePrefix).filter((value): value is string => value !== undefined))];
  const declared = validateRootNamespaces(root, requiredNamespaces);
  const frames: { readonly name: string; lastRank: number; readonly childCounts: Map<string, number> }[] = [];
  const uniqueIds = new Map<string, Set<string>>();
  for (const element of elements) {
    if (!allowed.has(element.name)) featureUnsupported('metadata_part');
    if (element.name === 'w:vanish' || element.name === 'w:webHidden' || element.name === 'w:specVanish') featureUnsupported('metadata_part');
    if (element.closing) {
      const frame = frames.pop();
      if (frame?.name !== element.name) formatCorrupt();
      for (const [child, [minimum, maximum]] of Object.entries(carrierChildCardinality[element.name] ?? {})) {
        const count = frame.childCounts.get(child) ?? 0;
        if (count < minimum || count > maximum) featureUnsupported('metadata_part');
      }
      continue;
    }
    if (!allowedParents.get(element.name)?.has(element.parent)) featureUnsupported('metadata_part');
    const parentFrame = frames.at(-1);
    if (parentFrame !== undefined) {
      const rank = childOrder[parentFrame.name]?.indexOf(element.name) ?? -1;
      if (rank < 0 || rank < parentFrame.lastRank) featureUnsupported('metadata_part');
      parentFrame.lastRank = rank;
      parentFrame.childCounts.set(element.name, (parentFrame.childCounts.get(element.name) ?? 0) + 1);
    }
    for (const name of requiredCarrierAttributes[element.name] ?? []) {
      const value = element.attributes[name];
      if (value === undefined || (value.length === 0 && !(element.name === 'w:lvlText' && name === 'w:val'))) {
        featureUnsupported('metadata_part');
      }
    }
    const identityAttribute = element.name === 'w:style' ? 'w:styleId'
      : element.name === 'w:abstractNum' ? 'w:abstractNumId'
        : element.name === 'w:num' ? 'w:numId' : undefined;
    if (identityAttribute !== undefined) {
      const ids = uniqueIds.get(element.name) ?? new Set<string>();
      const id = element.attributes[identityAttribute] ?? '';
      if (ids.has(id)) featureUnsupported('metadata_part');
      ids.add(id);
      uniqueIds.set(element.name, ids);
    }
    if (element.selfClosing && Object.values(carrierChildCardinality[element.name] ?? {}).some(([minimum]) => minimum > 0)) {
      featureUnsupported('metadata_part');
    }
    if (!element.selfClosing) frames.push({ name: element.name, lastRank: -1, childCounts: new Map() });
  }
  if (frames.length !== 0) formatCorrupt();
  return collectXmlAttributeCarriers(entry.name, elements, declared);
}

const supportedPartPattern = /^word\/(?:header[1-9][0-9]{0,5}|footer[1-9][0-9]{0,5}|footnotes|endnotes)\.xml$/u;
const supportedRelationshipPartPattern = /^word\/_rels\/(?:header[1-9][0-9]{0,5}|footer[1-9][0-9]{0,5}|footnotes|endnotes)\.xml\.rels$/u;
const supportedCustomXmlPartPattern = /^customXml\/(?:item1|itemProps1)\.xml$|^customXml\/_rels\/item1\.xml\.rels$/u;
const relationshipKinds: Readonly<Record<string, { readonly root: TextPartDescriptor['root']; readonly contentType: string; readonly target: RegExp }>> = Object.freeze({
  header: { root: 'w:hdr', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml', target: /^header[1-9][0-9]{0,5}\.xml$/u },
  footer: { root: 'w:ftr', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml', target: /^footer[1-9][0-9]{0,5}\.xml$/u },
  footnotes: { root: 'w:footnotes', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml', target: /^footnotes\.xml$/u },
  endnotes: { root: 'w:endnotes', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml', target: /^endnotes\.xml$/u }
});

const passiveRelationshipKinds: Readonly<Record<string, { readonly target: string; readonly part: string; readonly contentType: string }>> = Object.freeze({
  theme: { target: 'theme/theme1.xml', part: 'word/theme/theme1.xml', contentType: 'application/vnd.openxmlformats-officedocument.theme+xml' },
  webSettings: { target: 'webSettings.xml', part: 'word/webSettings.xml', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml' },
  settings: { target: 'settings.xml', part: 'word/settings.xml', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml' },
  numbering: { target: 'numbering.xml', part: 'word/numbering.xml', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml' },
  styles: { target: 'styles.xml', part: 'word/styles.xml', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml' },
  customXml: { target: '../customXml/item1.xml', part: 'customXml/item1.xml', contentType: 'application/xml' },
  fontTable: { target: 'fontTable.xml', part: 'word/fontTable.xml', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml' },
});

const carrierPartValidators: Readonly<Record<string, { readonly root: string; readonly elements: ReadonlySet<string>; readonly parents: ReadonlyMap<string, ReadonlySet<string | undefined>>; readonly order: Readonly<Record<string, readonly string[]>>; readonly maximumElements: number }>> = Object.freeze({
  'word/settings.xml': { root: 'w:settings', elements: settingsElements, parents: settingsParents, order: settingsOrder, maximumElements: 512 },
  'word/numbering.xml': { root: 'w:numbering', elements: numberingElements, parents: numberingParents, order: numberingOrder, maximumElements: 10_000 },
  'word/styles.xml': { root: 'w:styles', elements: stylesElements, parents: stylesParents, order: stylesOrder, maximumElements: 10_000 },
  'word/fontTable.xml': { root: 'w:fonts', elements: fontTableElements, parents: fontTableParents, order: fontTableOrder, maximumElements: 2_000 }
});

function unsupportedEntryReason(name: string): UnsupportedFeatureReason {
  if (/^(?:docProps|customXml)\//u.test(name) || /^word\/(?:styles|settings|theme|fontTable|numbering|webSettings)/u.test(name)) return 'metadata_part';
  if (/^(?:word\/media|word\/embeddings|word\/drawings)\//u.test(name)) return 'drawing_or_alternate_content';
  if (/^word\/(?:comments|glossary|subDoc)/u.test(name)) return 'additional_text_part';
  return 'unknown_feature';
}

function partSort(left: TextPartDescriptor, right: TextPartDescriptor): number {
  const rank = (name: string): number => name === 'word/document.xml' ? 0 : name.includes('/header') ? 1 : name.includes('/footer') ? 2 : name.endsWith('/footnotes.xml') ? 3 : 4;
  const difference = rank(left.name) - rank(right.name);
  if (difference !== 0) return difference;
  const suffix = (name: string): number => Number(/(?:header|footer)([1-9][0-9]*)\.xml$/u.exec(name)?.[1] ?? 0);
  const numericDifference = suffix(left.name) - suffix(right.name);
  if (numericDifference !== 0) return numericDifference;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function externalHyperlinkCarrier(sourcePart: string, relationshipPart: string, element: XmlElement): XmlCarrierValue {
  const id = element.attributes.Id ?? '';
  const target = element.attributes.Target ?? '';
  if (
    element.name !== 'Relationship' || !element.selfClosing || Object.keys(element.attributes).length !== 4
    || !/^rId[1-9][0-9]{0,5}$/u.test(id)
    || element.attributes.Type !== `${officeRelationshipPrefix}hyperlink`
    || element.attributes.TargetMode !== 'External'
    || unicodeCodePointLength(target) < 1 || unicodeCodePointLength(target) > maximumRelationshipTargetCodePoints
    || Array.from(target).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint === 0x7f || character === '\\';
    })
    || !/^(?:https:\/\/|mailto:)/iu.test(target)
  ) featureUnsupported('external_relationship');
  try {
    const parsed = new URL(target);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') || (parsed.protocol === 'https:' && parsed.hostname.length === 0)) {
      featureUnsupported('external_relationship');
    }
  } catch {
    featureUnsupported('external_relationship');
  }
  const raw = element.attributeRegions.Target;
  if (raw === undefined) formatCorrupt();
  return Object.freeze({
    value: target,
    part: relationshipPart,
    rawStart: raw.rawStart,
    rawEnd: raw.rawEnd,
    encoding: 'ATTRIBUTE',
    quote: raw.quote,
    location: Object.freeze({ schemaVersion: '2.0.0', kind: 'DOCX_RELATIONSHIP', sourcePart, relationshipId: id, field: 'TARGET' })
  });
}

function validateCustomXmlParts(byName: ReadonlyMap<string, ZipEntry>, declaredTypes: ReadonlyMap<string, string>): readonly XmlCarrierValue[] {
  const item = byName.get('customXml/item1.xml');
  const props = byName.get('customXml/itemProps1.xml');
  const rels = byName.get('customXml/_rels/item1.xml.rels');
  if (item === undefined && props === undefined && rels === undefined) return Object.freeze([]);
  if (item === undefined || props === undefined || rels === undefined) formatCorrupt();
  if (declaredTypes.get('customXml/itemProps1.xml') !== 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml') formatCorrupt();
  const bibliographyNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography';
  const customXmlNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/customXml';
  const itemElements = scanXml(decodeUtf8Xml(item.contents));
  const itemRoot = itemElements.find((element) => !element.closing);
  if (
    itemElements.filter((element) => !element.closing).length !== 1 || itemRoot?.name !== 'b:Sources'
    || itemRoot.attributes.xmlns !== bibliographyNamespace || itemRoot.attributes['xmlns:b'] !== bibliographyNamespace
  ) featureUnsupported('metadata_part');
  const itemDeclared = new Set(['b']);
  const propsElements = scanXml(decodeUtf8Xml(props.contents));
  const propsRoot = propsElements.find((element) => !element.closing);
  if (
    propsRoot?.name !== 'ds:datastoreItem' || propsRoot.attributes['xmlns:ds'] !== customXmlNamespace
    || propsElements.filter((element) => !element.closing).map((element) => element.name).join('\u0000') !== 'ds:datastoreItem\u0000ds:schemaRefs\u0000ds:schemaRef'
    || propsElements.find((element) => !element.closing && element.name === 'ds:schemaRefs')?.parent !== 'ds:datastoreItem'
    || propsElements.find((element) => !element.closing && element.name === 'ds:schemaRef')?.parent !== 'ds:schemaRefs'
  ) featureUnsupported('metadata_part');
  const relationshipElements = elementsByName(decodeUtf8Xml(rels.contents), 'Relationships');
  const relationshipRoot = relationshipElements.find((element) => !element.closing);
  const relationship = relationshipElements.filter((element) => !element.closing && element.name === 'Relationship');
  const customXmlRelationship = relationship[0];
  if (
    relationshipRoot?.attributes.xmlns !== relationshipNamespace || relationship.length !== 1
    || customXmlRelationship === undefined || Object.keys(customXmlRelationship.attributes).length !== 3
    || customXmlRelationship.attributes.Id !== 'rId1'
    || customXmlRelationship.attributes.Type !== `${officeRelationshipPrefix}customXmlProps`
    || customXmlRelationship.attributes.Target !== 'itemProps1.xml'
  ) featureUnsupported('metadata_part');
  return Object.freeze([
    ...collectXmlAttributeCarriers(item.name, itemElements, itemDeclared),
    ...collectXmlAttributeCarriers(props.name, propsElements, new Set(['ds']))
  ]);
}

function validateExtendedPropertyFrames(elements: readonly XmlElement[]): void {
  const frames: { readonly name: string; readonly parent?: string; readonly attributes: Readonly<Record<string, string>>; readonly children: string[] }[] = [];
  const validateFrame = (frame: { readonly name: string; readonly parent?: string; readonly attributes: Readonly<Record<string, string>>; readonly children: readonly string[] }): void => {
    if (frame.name === 'HeadingPairs' || frame.name === 'TitlesOfParts') {
      if (frame.children.join('\u0000') !== 'vt:vector') featureUnsupported('metadata_part');
      return;
    }
    if (frame.name === 'vt:vector') {
      const expectedBase = frame.parent === 'HeadingPairs' ? 'variant' : frame.parent === 'TitlesOfParts' ? 'lpstr' : undefined;
      const size = Number(frame.attributes.size);
      const expectedChild = expectedBase === 'variant' ? 'vt:variant' : 'vt:lpstr';
      if (
        expectedBase === undefined || Object.keys(frame.attributes).length !== 2
        || frame.attributes.baseType !== expectedBase || !Number.isSafeInteger(size)
        || size < 1 || size > 256 || size !== frame.children.length
        || frame.children.some((child) => child !== expectedChild)
      ) featureUnsupported('metadata_part');
      return;
    }
    if (frame.name === 'vt:variant' && (
      Object.keys(frame.attributes).length !== 0 || frame.children.length !== 1
      || !['vt:lpstr', 'vt:i4'].includes(frame.children[0] ?? '')
    )) featureUnsupported('metadata_part');
  };
  for (const element of elements) {
    if (!element.closing) {
      frames.at(-1)?.children.push(element.name);
      if (element.selfClosing) validateFrame({ name: element.name, ...(element.parent === undefined ? {} : { parent: element.parent }), attributes: element.attributes, children: [] });
      else frames.push({ name: element.name, ...(element.parent === undefined ? {} : { parent: element.parent }), attributes: element.attributes, children: [] });
      continue;
    }
    const frame = frames.pop();
    if (frame?.name !== element.name) formatCorrupt();
    validateFrame(frame);
  }
  if (frames.length !== 0) formatCorrupt();
}

function validatePropertyPart(entry: ZipEntry): readonly XmlCarrierValue[] {
  const core = entry.name === 'docProps/core.xml';
  const allowed = core
    ? new Set(['cp:coreProperties', 'dc:creator', 'dc:description', 'dc:language', 'dc:subject', 'dc:title', 'dcterms:created', 'dcterms:modified', 'cp:lastModifiedBy', 'cp:lastPrinted', 'cp:revision'])
    : new Set(['Properties', 'Template', 'TotalTime', 'Pages', 'Words', 'Characters', 'Application', 'DocSecurity', 'Lines', 'Paragraphs', 'ScaleCrop', 'HeadingPairs', 'TitlesOfParts', 'Company', 'LinksUpToDate', 'CharactersWithSpaces', 'SharedDoc', 'HyperlinksChanged', 'AppVersion', 'vt:vector', 'vt:variant', 'vt:lpstr', 'vt:i4']);
  const textElements = new Set([...allowed].filter((name) => name !== 'cp:coreProperties' && name !== 'Properties' && name !== 'HeadingPairs' && name !== 'TitlesOfParts' && name !== 'vt:vector' && name !== 'vt:variant'));
  const xml = decodeUtf8Xml(entry.contents);
  const elements = scanXml(xml, textElements);
  const root = elements.find((element) => !element.closing);
  if (root?.name !== (core ? 'cp:coreProperties' : 'Properties')) formatCorrupt();
  if (elements.some((element) => !allowed.has(element.name))) featureUnsupported('metadata_part');
  if (core) {
    const expected = new Map([
      ['cp', 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties'],
      ['dc', 'http://purl.org/dc/elements/1.1/'], ['dcterms', 'http://purl.org/dc/terms/'],
      ['dcmitype', 'http://purl.org/dc/dcmitype/'], ['xsi', 'http://www.w3.org/2001/XMLSchema-instance']
    ]);
    for (const [prefix, uri] of expected) if (root.attributes[`xmlns:${prefix}`] !== uri) featureUnsupported('metadata_part');
    if (Object.keys(root.attributes).length !== expected.size) featureUnsupported('metadata_part');
    const order = ['dc:title', 'dc:subject', 'dc:creator', 'dc:description', 'cp:lastModifiedBy', 'cp:revision', 'cp:lastPrinted', 'dcterms:created', 'dcterms:modified', 'dc:language'];
    let lastRank = -1;
    const seen = new Set<string>();
    for (const element of elements) {
      if (element.closing || element === root) continue;
      if (element.parent !== 'cp:coreProperties' || seen.has(element.name)) featureUnsupported('metadata_part');
      seen.add(element.name);
      const rank = order.indexOf(element.name);
      if (rank < 0 || rank < lastRank) featureUnsupported('metadata_part');
      lastRank = rank;
      const attributes = Object.entries(element.attributes);
      if (element.name === 'dcterms:created' || element.name === 'dcterms:modified') {
        if (attributes.length !== 1 || element.attributes['xsi:type'] !== 'dcterms:W3CDTF') featureUnsupported('metadata_part');
      } else if (attributes.length !== 0) featureUnsupported('metadata_part');
    }
    const carriers = collectXmlAttributeCarriers(entry.name, elements, new Set(expected.keys()));
    return Object.freeze([...carriers, ...collectXmlTextCarriers(entry.name, xml, elements, textElements)]);
  }
  if (
    root.attributes.xmlns !== 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'
    || root.attributes['xmlns:vt'] !== 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'
    || Object.keys(root.attributes).length !== 2
  ) featureUnsupported('metadata_part');
  validateExtendedPropertyFrames(elements);
  const appOrder = ['Template', 'TotalTime', 'Pages', 'Words', 'Characters', 'Application', 'DocSecurity', 'Lines', 'Paragraphs', 'ScaleCrop', 'HeadingPairs', 'TitlesOfParts', 'Company', 'LinksUpToDate', 'CharactersWithSpaces', 'SharedDoc', 'HyperlinksChanged', 'AppVersion'];
  let appRank = -1;
  const appSeen = new Set<string>();
  const parentsByElement: Readonly<Record<string, ReadonlySet<string>>> = {
    'vt:vector': new Set(['HeadingPairs', 'TitlesOfParts']), 'vt:variant': new Set(['vt:vector']),
    'vt:lpstr': new Set(['vt:variant', 'vt:vector']), 'vt:i4': new Set(['vt:variant'])
  };
  for (const element of elements) {
    if (element.closing) continue;
    if (element === root) continue;
    if (element.name.startsWith('vt:')) {
      if (element.parent === undefined || !parentsByElement[element.name]?.has(element.parent)) featureUnsupported('metadata_part');
    } else {
      if (element.parent !== 'Properties' || appSeen.has(element.name)) featureUnsupported('metadata_part');
      appSeen.add(element.name);
      const rank = appOrder.indexOf(element.name);
      if (rank < 0 || rank < appRank) featureUnsupported('metadata_part');
      appRank = rank;
    }
    const attributes = Object.entries(element.attributes);
    if (element.name === 'vt:vector') {
      const size = Number(element.attributes.size);
      const expectedBase = element.parent === 'HeadingPairs' ? 'variant' : 'lpstr';
      if (
        attributes.length !== 2 || element.attributes.baseType !== expectedBase
        || !Number.isSafeInteger(size) || size < 1 || size > 256
      ) featureUnsupported('metadata_part');
    } else if (attributes.length !== 0) {
      featureUnsupported('metadata_part');
    }
  }
  return collectXmlTextCarriers(entry.name, xml, elements, textElements);
}

function validatePackage(entries: readonly ZipEntry[]): ParsedDocxPackage {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const fixed = new Set(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels']);
  for (const entry of entries) {
    if (
      !fixed.has(entry.name)
      && !supportedPartPattern.test(entry.name)
      && !supportedRelationshipPartPattern.test(entry.name)
      && !supportedCustomXmlPartPattern.test(entry.name)
      && entry.name !== 'docProps/core.xml'
      && entry.name !== 'docProps/app.xml'
      && passivePartProfiles[entry.name] === undefined
      && carrierPartValidators[entry.name] === undefined
    ) {
      featureUnsupported(unsupportedEntryReason(entry.name));
    }
  }
  const contentTypesEntry = byName.get('[Content_Types].xml');
  const rootRelsEntry = byName.get('_rels/.rels');
  const documentEntry = byName.get('word/document.xml');
  if (contentTypesEntry === undefined || rootRelsEntry === undefined || documentEntry === undefined) formatCorrupt();

  const contentTypesXml = decodeUtf8Xml(contentTypesEntry.contents);
  const contentElements = elementsByName(contentTypesXml, 'Types');
  const contentRoot = contentElements.find((element) => !element.closing);
  if (contentRoot?.attributes.xmlns !== contentTypesNamespace || Object.keys(contentRoot.attributes).length !== 1) formatCorrupt();
  const declaredTypes = new Map<string, string>();
  let relsDefaultFound = false;
  let xmlDefaultFound = false;
  for (const element of contentElements) {
    if (element.closing || element.name === 'Types') continue;
    if ((element.name !== 'Default' && element.name !== 'Override') || !element.selfClosing) formatCorrupt();
    const contentType = element.attributes.ContentType;
    if (contentType === undefined || /macro|vba|ole|activeX/iu.test(contentType)) featureUnsupported();
    if (element.name === 'Default') {
      if (Object.keys(element.attributes).length !== 2) featureUnsupported();
      if (element.attributes.Extension === 'rels' && contentType === 'application/vnd.openxmlformats-package.relationships+xml' && !relsDefaultFound) relsDefaultFound = true;
      else if (element.attributes.Extension === 'xml' && contentType === 'application/xml' && !xmlDefaultFound) xmlDefaultFound = true;
      else featureUnsupported();
    } else {
      const partName = element.attributes.PartName;
      if (Object.keys(element.attributes).length !== 2 || partName === undefined || !partName.startsWith('/') || declaredTypes.has(partName.slice(1))) formatCorrupt();
      const normalized = partName.slice(1);
      if (
        normalized !== 'word/document.xml'
        && !supportedPartPattern.test(normalized)
        && passivePartProfiles[normalized] === undefined
        && carrierPartValidators[normalized] === undefined
        && normalized !== 'customXml/itemProps1.xml'
        && normalized !== 'docProps/core.xml'
        && normalized !== 'docProps/app.xml'
      ) featureUnsupported(unsupportedEntryReason(normalized));
      declaredTypes.set(normalized, contentType);
    }
  }
  if (!documentPartContentTypes.has(declaredTypes.get('word/document.xml') ?? '') || !relsDefaultFound || !xmlDefaultFound) formatCorrupt();

  const rootRelsXml = decodeUtf8Xml(rootRelsEntry.contents);
  const rootRelationships = elementsByName(rootRelsXml, 'Relationships');
  const rootRelsRoot = rootRelationships.find((element) => !element.closing);
  if (rootRelsRoot?.attributes.xmlns !== relationshipNamespace || Object.keys(rootRelsRoot.attributes).length !== 1) formatCorrupt();
  let officeDocumentFound = false;
  const rootPropertyParts = new Set<string>();
  const rootRelationshipIds = new Set<string>();
  for (const element of rootRelationships) {
    if (element.closing || element.name === 'Relationships') continue;
    if (element.name !== 'Relationship' || !element.selfClosing) featureUnsupported('unknown_feature');
    if (element.attributes.TargetMode === 'External') featureUnsupported('external_relationship');
    const id = element.attributes.Id ?? '';
    if (Object.keys(element.attributes).length !== 3 || !/^rId[1-9][0-9]{0,5}$/u.test(id) || rootRelationshipIds.has(id)) featureUnsupported('unknown_feature');
    rootRelationshipIds.add(id);
    const type = element.attributes.Type;
    const target = element.attributes.Target;
    if (type === `${officeRelationshipPrefix}officeDocument` && target === 'word/document.xml' && !officeDocumentFound) officeDocumentFound = true;
    else if (type === 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties' && target === 'docProps/core.xml') rootPropertyParts.add(target);
    else if (type === `${officeRelationshipPrefix}extended-properties` && target === 'docProps/app.xml') rootPropertyParts.add(target);
    else featureUnsupported('unknown_feature');
  }
  if (!officeDocumentFound) formatCorrupt();
  for (const part of ['docProps/core.xml', 'docProps/app.xml']) if (byName.has(part) !== rootPropertyParts.has(part)) formatCorrupt();
  if (byName.has('docProps/core.xml') && declaredTypes.get('docProps/core.xml') !== 'application/vnd.openxmlformats-package.core-properties+xml') formatCorrupt();
  if (byName.has('docProps/app.xml') && declaredTypes.get('docProps/app.xml') !== 'application/vnd.openxmlformats-officedocument.extended-properties+xml') formatCorrupt();

  const relatedParts = new Map<string, { readonly id: string; readonly kind: string }>();
  const relatedPassiveParts = new Map<string, { readonly id: string; readonly kind: string }>();
  const relationshipIds = new Set<string>();
  const externalRelationshipIdsByPart = new Map<string, Set<string>>();
  const carriers: XmlCarrierValue[] = [];
  const documentRels = byName.get('word/_rels/document.xml.rels');
  if (documentRels !== undefined) {
    const relationships = elementsByName(decodeUtf8Xml(documentRels.contents), 'Relationships');
    const relsRoot = relationships.find((element) => !element.closing);
    if (relsRoot?.attributes.xmlns !== relationshipNamespace || Object.keys(relsRoot.attributes).length !== 1) formatCorrupt();
    for (const element of relationships) {
      if (element.closing || element.name === 'Relationships') continue;
      if (element.attributes.TargetMode === 'External') {
        const carrier = externalHyperlinkCarrier('word/document.xml', 'word/_rels/document.xml.rels', element);
        const id = element.attributes.Id ?? '';
        if (relationshipIds.has(id)) formatCorrupt();
        relationshipIds.add(id);
        carriers.push(carrier);
        externalRelationshipIdsByPart.set('word/document.xml', new Set([...(externalRelationshipIdsByPart.get('word/document.xml') ?? []), id]));
        continue;
      }
      if (
        element.name !== 'Relationship' || !element.selfClosing
        || Object.keys(element.attributes).length !== 3 || !/^rId[1-9][0-9]{0,5}$/u.test(element.attributes.Id ?? '')
      ) featureUnsupported('unknown_feature');
      const type = element.attributes.Type;
      const target = element.attributes.Target;
      const kind = type?.startsWith(officeRelationshipPrefix) === true ? type.slice(officeRelationshipPrefix.length) : undefined;
      if (kind === undefined || target === undefined) featureUnsupported('unknown_feature');
      const textRelationship = relationshipKinds[kind];
      const passiveRelationship = passiveRelationshipKinds[kind];
      if (textRelationship === undefined && passiveRelationship === undefined) featureUnsupported(unsupportedEntryReason(`word/${target}`));
      if (passiveRelationship !== undefined && passiveRelationship.target !== target) featureUnsupported('metadata_part');
      const part = passiveRelationship?.part ?? `word/${target}`;
      if (
        !byName.has(part)
        || relationshipIds.has(element.attributes.Id ?? '')
        || (textRelationship !== undefined && (!textRelationship.target.test(target) || relatedParts.has(part)))
        || (passiveRelationship !== undefined && (passiveRelationship.target !== target || relatedPassiveParts.has(part)))
      ) formatCorrupt();
      relationshipIds.add(element.attributes.Id ?? '');
      (textRelationship === undefined ? relatedPassiveParts : relatedParts).set(part, { id: element.attributes.Id ?? '', kind });
    }
  }
  for (const entry of entries) {
    if (!supportedRelationshipPartPattern.test(entry.name)) continue;
    const match = /^word\/_rels\/(.+)\.rels$/u.exec(entry.name);
    const sourcePart = match?.[1] === undefined ? '' : `word/${match[1]}`;
    if (!supportedPartPattern.test(sourcePart) || !byName.has(sourcePart)) formatCorrupt();
    const relationships = elementsByName(decodeUtf8Xml(entry.contents), 'Relationships');
    const relsRoot = relationships.find((element) => !element.closing);
    if (relsRoot?.attributes.xmlns !== relationshipNamespace || Object.keys(relsRoot.attributes).length !== 1) formatCorrupt();
    const ids = new Set<string>();
    for (const element of relationships) {
      if (element.closing || element.name === 'Relationships') continue;
      const carrier = externalHyperlinkCarrier(sourcePart, entry.name, element);
      const id = element.attributes.Id ?? '';
      if (ids.has(id)) formatCorrupt();
      ids.add(id);
      carriers.push(carrier);
    }
    if (ids.size === 0) formatCorrupt();
    externalRelationshipIdsByPart.set(sourcePart, ids);
  }
  for (const part of byName.keys()) {
    if (supportedPartPattern.test(part) && !relatedParts.has(part)) formatCorrupt();
  }
  for (const [part, relationship] of relatedParts) {
    const expected = relationshipKinds[relationship.kind]?.contentType;
    if (declaredTypes.get(part) !== expected) formatCorrupt();
  }
  for (const [part, relationship] of relatedPassiveParts) {
    const expected = passiveRelationshipKinds[relationship.kind]?.contentType;
    if (expected !== 'application/xml' && declaredTypes.get(part) !== expected) formatCorrupt();
  }
  for (const part of declaredTypes.keys()) {
    if (
      part !== 'word/document.xml'
      && part !== 'customXml/itemProps1.xml'
      && part !== 'docProps/core.xml'
      && part !== 'docProps/app.xml'
      && !relatedParts.has(part)
      && !relatedPassiveParts.has(part)
    ) formatCorrupt();
  }

  for (const [part, profile] of Object.entries(passivePartProfiles)) {
    const entry = byName.get(part);
    if (entry !== undefined) validatePassivePart(entry, profile);
  }
  for (const part of Object.keys(passivePartProfiles)) if (byName.has(part) !== relatedPassiveParts.has(part)) formatCorrupt();
  for (const [part, profile] of Object.entries(carrierPartValidators)) {
    const entry = byName.get(part);
    if (entry !== undefined) carriers.push(...validateWordCarrierPart(
      entry, profile.root, profile.elements, profile.parents, profile.order, profile.maximumElements
    ));
    if (byName.has(part) !== relatedPassiveParts.has(part)) formatCorrupt();
  }
  carriers.push(...validateCustomXmlParts(byName, declaredTypes));
  for (const part of ['docProps/core.xml', 'docProps/app.xml']) {
    const entry = byName.get(part);
    if (entry !== undefined) carriers.push(...validatePropertyPart(entry));
  }

  const descriptors: TextPartDescriptor[] = [{ name: 'word/document.xml', root: 'w:document' }];
  for (const [part, relationship] of relatedParts) {
    const root = relationshipKinds[relationship.kind]?.root;
    if (root === undefined) formatCorrupt();
    descriptors.push({ name: part, root });
  }
  descriptors.sort(partSort);
  const rawParts = descriptors.map((descriptor) => {
    const entry = byName.get(descriptor.name);
    if (entry === undefined) return formatCorrupt();
    return parseTextPart(entry.contents, descriptor);
  });
  for (const part of rawParts) carriers.push(...part.carriers);
  const document = rawParts[0];
  if (document === undefined || document.descriptor.name !== 'word/document.xml') formatCorrupt();
  const referenced = document.referencedHeaderFooterKinds;
  for (const [part, relationship] of relatedParts) {
    if ((relationship.kind === 'header' || relationship.kind === 'footer') && referenced.get(relationship.id) !== relationship.kind) formatCorrupt();
    if (referenced.has(relationship.id) && relationship.kind !== 'header' && relationship.kind !== 'footer') formatCorrupt();
    if (!part.startsWith('word/')) formatCorrupt();
  }
  for (const id of referenced.keys()) if (!relationshipIds.has(id)) formatCorrupt();
  for (const part of rawParts) {
    const declared = externalRelationshipIdsByPart.get(part.descriptor.name) ?? new Set<string>();
    if (declared.size !== part.referencedHyperlinkIds.size) formatCorrupt();
    for (const id of declared) if (!part.referencedHyperlinkIds.has(id)) formatCorrupt();
  }
  const footnotes = rawParts.find((part) => part.descriptor.root === 'w:footnotes');
  const endnotes = rawParts.find((part) => part.descriptor.root === 'w:endnotes');
  const assertNoteGraph = (references: ReadonlySet<number>, part: ParsedTextPartRaw | undefined): void => {
    if (references.size > 0 && part === undefined) formatCorrupt();
    if (part !== undefined) {
      for (const id of references) if (!part.declaredNoteIds.has(id)) formatCorrupt();
      for (const id of part.declaredNoteIds) if (!references.has(id)) formatCorrupt();
    }
  };
  assertNoteGraph(document.referencedFootnoteIds, footnotes);
  assertNoteGraph(document.referencedEndnoteIds, endnotes);
  carriers.sort((left, right) => {
    const leftIdentity = carrierIdentity(left);
    const rightIdentity = carrierIdentity(right);
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  });
  return assembleTextParts(rawParts, carriers);
}

export interface DocxArtifact {
  readonly reference: string;
  readonly path: string;
  readonly displayName: string;
  readonly mediaType: typeof docxMediaType;
  readonly byteLength: number;
  readonly digest: Sha256Digest;
  readonly extractionRevision: Sha256Digest;
  readonly canonicalText: string;
  readonly text: string;
  readonly hasUtf8Bom: false;
  readonly regions: readonly CanonicalRegion[];
}

interface DocxArtifactState {
  readonly entries: readonly ZipEntry[];
  readonly package: ParsedDocxPackage;
}

const docxArtifactStates = new WeakMap<DocxArtifact, DocxArtifactState>();

async function readBoundedBinary(requestedPath: string, maximumBytes: number, fileSystem: TextArtifactFileSystem): Promise<{ readonly path: string; readonly bytes: Buffer; readonly metadata: Stats }> {
  let handle;
  try {
    const linkMetadata = await fileSystem.lstat(requestedPath);
    if (linkMetadata.isSymbolicLink() || !linkMetadata.isFile()) {
      throw new SafeError({ code: 'FORMAT_UNSUPPORTED', message: 'The DOCX input must be a regular non-symbolic file.', retryable: false, correlationId: 'cor_docx_adapter' });
    }
    const path = await fileSystem.realpath(requestedPath);
    handle = await fileSystem.openRead(path);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.dev !== linkMetadata.dev || metadata.ino !== linkMetadata.ino) formatCorrupt();
    if (metadata.size > maximumBytes) {
      throw new SafeError({ code: 'INPUT_TOO_LARGE', message: 'The DOCX input exceeds the configured byte limit.', retryable: false, correlationId: 'cor_docx_adapter' });
    }
    const bytes = Buffer.alloc(metadata.size);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, Math.min(64 * 1024, bytes.length - total), total);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > bytes.length - total) formatCorrupt();
      total += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size
      || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs
    ) throw new SafeError({ code: 'JOB_CONFLICT', message: 'The DOCX input changed while it was being read.', retryable: true, correlationId: 'cor_docx_adapter' });
    return { path, bytes, metadata };
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    throw storageUnavailable('The DOCX input could not be read.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readDocxArtifact(
  inputPath: string,
  maximumBytes = defaultMaximumDocxInputBytes,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
): Promise<DocxArtifact> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > defaultMaximumDocxInputBytes) {
    throw new TypeError('Maximum DOCX input bytes must be within the adapter limit.');
  }
  if (extname(inputPath).toLowerCase() !== '.docx') {
    throw new SafeError({ code: 'FORMAT_UNSUPPORTED', message: 'This adapter supports DOCX files only.', retryable: false, correlationId: 'cor_docx_adapter' });
  }
  const requestedPath = resolve(inputPath);
  const { path, bytes } = await readBoundedBinary(requestedPath, maximumBytes, fileSystem);
  const entries = parseZip(bytes);
  const parsedPackage = validatePackage(entries);
  const artifact: DocxArtifact = Object.freeze({
    reference: path,
    path,
    displayName: basename(path),
    mediaType: docxMediaType,
    byteLength: bytes.length,
    digest: digestBytes(bytes),
    extractionRevision: parsedPackage.extractionRevision,
    canonicalText: parsedPackage.canonicalText,
    text: parsedPackage.canonicalText,
    hasUtf8Bom: false,
    regions: parsedPackage.canonicalRegions
  });
  docxArtifactStates.set(artifact, { entries, package: parsedPackage });
  return artifact;
}

interface DocxPlanAssignments {
  readonly nodes: ReadonlyMap<TextNodeRegion, readonly TypedLabelAction[]>;
  readonly carriers: ReadonlyMap<MappedXmlCarrierValue, readonly TypedLabelAction[]>;
}

function assertPlan(plan: TypedLabelPlan, source: DocxArtifact, parsedPackage: ParsedDocxPackage): DocxPlanAssignments {
  try {
    assertTypedLabelPlanIntegrity(plan);
  } catch {
    throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan provenance is invalid.', retryable: false, correlationId: 'cor_docx_adapter' });
  }
  if (
    plan.inputDigest !== source.digest
    || plan.extractionRevision !== source.extractionRevision
    || plan.writer.id !== docxWriterDescriptor.id
    || plan.writer.version !== docxWriterDescriptor.version
  ) {
    throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan does not match this DOCX input.', retryable: false, correlationId: 'cor_docx_adapter' });
  }
  if (!Number.isSafeInteger(plan.expectedActionCount) || plan.expectedActionCount < 0 || plan.expectedActionCount > maximumPlanActions || plan.expectedActionCount !== plan.actions.length) {
    throw new SafeError({ code: 'REDACTION_COUNT_MISMATCH', message: 'The redaction plan action count is invalid.', retryable: false, correlationId: 'cor_docx_adapter' });
  }
  const sourceLength = unicodeCodePointLength(source.text);
  const ids = new Set<string>();
  const sorted = [...plan.actions].sort((left, right) => left.start - right.start || left.end - right.end);
  for (const action of sorted) {
    if (
      !actionIdPattern.test(action.id) || ids.has(action.id)
      || !Number.isSafeInteger(action.start) || !Number.isSafeInteger(action.end)
      || action.start < 0 || action.start >= action.end || action.end > sourceLength
      || typeof action.replacement !== 'string' || unicodeCodePointLength(action.replacement) > 500
      || !isXml10String(action.replacement)
    ) throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan actions are invalid.', retryable: false, correlationId: 'cor_docx_adapter' });
    ids.add(action.id);
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if ((sorted[index - 1]?.end ?? 0) > (sorted[index]?.start ?? 0)) {
      throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan contains overlapping actions.', retryable: false, correlationId: 'cor_docx_adapter' });
    }
  }
  const nodeAssignments = new Map<TextNodeRegion, TypedLabelAction[]>();
  const carrierAssignments = new Map<MappedXmlCarrierValue, TypedLabelAction[]>();
  const writableRegions = [
    ...parsedPackage.segments.map((segment) => ({ kind: 'SEGMENT' as const, start: segment.canonicalStart, end: segment.canonicalEnd, segment })),
    ...parsedPackage.carriers.map((carrier) => ({ kind: 'CARRIER' as const, start: carrier.canonicalStart, end: carrier.canonicalEnd, carrier }))
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  let regionIndex = 0;
  for (const action of sorted) {
    let region = writableRegions[regionIndex];
    while (region !== undefined && action.start >= region.end) region = writableRegions[++regionIndex];
    if (region === undefined || action.start < region.start || action.end > region.end) {
      throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'A redaction action crosses a DOCX structural boundary.', retryable: false, correlationId: 'cor_docx_adapter' });
    }
    if (region.kind === 'CARRIER') {
      const assigned = carrierAssignments.get(region.carrier) ?? [];
      assigned.push(action);
      carrierAssignments.set(region.carrier, assigned);
      continue;
    }
    for (const node of region.segment.nodes) {
      if (action.start < node.canonicalEnd && action.end > node.canonicalStart) {
        const assigned = nodeAssignments.get(node) ?? [];
        assigned.push(action);
        nodeAssignments.set(node, assigned);
      }
    }
  }
  return { nodes: nodeAssignments, carriers: carrierAssignments };
}

function codePointToUtf16(value: string, target: number): number {
  let utf16 = 0;
  let codePoints = 0;
  while (utf16 < value.length && codePoints < target) {
    utf16 += (value.codePointAt(utf16) ?? 0) > 0xffff ? 2 : 1;
    codePoints += 1;
  }
  if (codePoints !== target) formatCorrupt();
  return utf16;
}

function transformNode(node: TextNodeRegion, actions: readonly TypedLabelAction[]): string {
  const parts: string[] = [];
  let cursor = node.canonicalStart;
  for (const action of actions) {
    const overlapStart = Math.max(action.start, node.canonicalStart);
    const overlapEnd = Math.min(action.end, node.canonicalEnd);
    if (overlapStart > cursor) parts.push(node.value.slice(codePointToUtf16(node.value, cursor - node.canonicalStart), codePointToUtf16(node.value, overlapStart - node.canonicalStart)));
    if (action.start >= node.canonicalStart && action.start < node.canonicalEnd) parts.push(action.replacement);
    cursor = Math.max(cursor, overlapEnd);
  }
  if (cursor < node.canonicalEnd) parts.push(node.value.slice(codePointToUtf16(node.value, cursor - node.canonicalStart)));
  const transformed = parts.join('');
  if (!node.preservesWhitespace && (/^\s/u.test(transformed) || /\s$/u.test(transformed))) {
    throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'A DOCX replacement requires unsupported whitespace-preservation changes.', retryable: false, correlationId: 'cor_docx_adapter' });
  }
  return transformed;
}

function transformCarrier(carrier: MappedXmlCarrierValue, actions: readonly TypedLabelAction[]): string {
  const parts: string[] = [];
  let cursor = carrier.canonicalStart;
  for (const action of actions) {
    if (action.start > cursor) {
      parts.push(carrier.value.slice(
        codePointToUtf16(carrier.value, cursor - carrier.canonicalStart),
        codePointToUtf16(carrier.value, action.start - carrier.canonicalStart)
      ));
    }
    parts.push(action.replacement);
    cursor = action.end;
  }
  if (cursor < carrier.canonicalEnd) {
    parts.push(carrier.value.slice(codePointToUtf16(carrier.value, cursor - carrier.canonicalStart)));
  }
  return parts.join('');
}

function encodeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function encodeXmlAttribute(value: string, quote: '"' | "'"): string {
  const encoded = encodeXmlText(value);
  return quote === '"' ? encoded.replaceAll('"', '&quot;') : encoded.replaceAll("'", '&apos;');
}

function applyDocxPlan(source: DocxArtifact, plan: TypedLabelPlan): Buffer {
  const state = docxArtifactStates.get(source);
  if (state === undefined) throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The DOCX extraction state is unavailable.', retryable: false, correlationId: 'cor_docx_adapter' });
  const assignments = assertPlan(plan, source, state.package);
  const rewritesByPart = new Map<string, Array<{ readonly rawStart: number; readonly rawEnd: number; readonly value: string }>>();
  for (const part of state.package.parts) {
    for (const node of part.segments.flatMap((segment) => segment.nodes).filter((candidate) => assignments.nodes.has(candidate))) {
      const rewrites = rewritesByPart.get(part.name) ?? [];
      rewrites.push({ rawStart: node.rawStart, rawEnd: node.rawEnd, value: encodeXmlText(transformNode(node, assignments.nodes.get(node) ?? [])) });
      rewritesByPart.set(part.name, rewrites);
    }
  }
  for (const carrier of state.package.carriers) {
    const actions = assignments.carriers.get(carrier);
    if (actions === undefined) continue;
    const transformed = transformCarrier(carrier, actions);
    const value = carrier.encoding === 'ATTRIBUTE'
      ? encodeXmlAttribute(transformed, carrier.quote ?? '"')
      : encodeXmlText(transformed);
    const rewrites = rewritesByPart.get(carrier.part) ?? [];
    rewrites.push({ rawStart: carrier.rawStart, rawEnd: carrier.rawEnd, value });
    rewritesByPart.set(carrier.part, rewrites);
  }
  const rewritten = new Map<string, Buffer>();
  for (const entry of state.entries) {
    const rewrites = rewritesByPart.get(entry.name)?.sort((left, right) => left.rawStart - right.rawStart || left.rawEnd - right.rawEnd);
    if (rewrites === undefined || rewrites.length === 0) continue;
    const xml = decodeUtf8Xml(entry.contents);
    const output: string[] = [];
    let cursor = 0;
    for (const rewrite of rewrites) {
      if (rewrite.rawStart < cursor || rewrite.rawEnd < rewrite.rawStart || rewrite.rawEnd > xml.length) formatCorrupt();
      output.push(xml.slice(cursor, rewrite.rawStart), rewrite.value);
      cursor = rewrite.rawEnd;
    }
    output.push(xml.slice(cursor));
    rewritten.set(entry.name, Buffer.from(output.join(''), 'utf8'));
  }
  const outputEntries = state.entries.map((entry) => rewritten.has(entry.name)
    ? Object.freeze({ ...entry, contents: rewritten.get(entry.name) ?? entry.contents })
    : entry);
  const output = writeZip(outputEntries);
  validatePackage(parseZip(output));
  return output;
}

function createReceipt(plan: TypedLabelPlan, staged: Pick<StagedTextArtifact, 'digest' | 'byteLength'>): WriterReceipt {
  const unsigned: Omit<WriterReceipt, 'receiptDigest'> = {
    schemaVersion: '1.0.0',
    planDigest: parseSha256Digest(plan.digest),
    writer: { id: docxWriterDescriptor.id, version: docxWriterDescriptor.version },
    stagedDigest: staged.digest,
    stagedByteLength: staged.byteLength,
    expectedActionCount: plan.expectedActionCount,
    appliedActionCount: plan.actions.length,
    appliedActionIds: plan.actions.map(({ id }) => id)
  };
  return Object.freeze({ ...unsigned, receiptDigest: parseSha256Digest(computeWriterReceiptDigest(unsigned)) });
}

function docxVerificationIncomplete(reason: string): never {
  throw new SafeError({
    code: 'VERIFICATION_INCOMPLETE',
    message: 'The staged DOCX artifact did not satisfy the bounded native reconciliation foundation.',
    retryable: false,
    correlationId: 'cor_docx_adapter',
    details: { reason }
  });
}

function unicodeSlice(value: string, start: number, end: number): string {
  return value.slice(codePointToUtf16(value, start), codePointToUtf16(value, end));
}

function expectedCanonicalText(source: string, plan: TypedLabelPlan): string {
  const output: string[] = [];
  let cursor = 0;
  for (const action of [...plan.actions].sort((left, right) => left.start - right.start || left.end - right.end)) {
    output.push(unicodeSlice(source, cursor, action.start), action.replacement);
    cursor = action.end;
  }
  output.push(unicodeSlice(source, cursor, unicodeCodePointLength(source)));
  return output.join('');
}

function nativeRegionIdentity(region: CanonicalRegion): string {
  const location = region.location;
  if (location.kind === 'DOCX_PART') return `P\u0000${location.part}\u0000${String(location.paragraph)}`;
  if (location.kind === 'DOCX_RELATIONSHIP') {
    return `R\u0000${location.sourcePart}\u0000${location.relationshipId}\u0000${location.field}`;
  }
  if (location.kind === 'DOCX_XML_VALUE') {
    return `X\u0000${location.part}\u0000${location.element}\u0000${String(location.elementOrdinal)}\u0000${location.carrier}\u0000${location.attribute ?? ''}`;
  }
  return JSON.stringify(location);
}

function qualifiedCarrierValues(artifact: DocxArtifact): readonly (readonly [string, string])[] {
  return Object.freeze(artifact.regions.flatMap((region) => {
    if (region.location.kind !== 'DOCX_RELATIONSHIP' && region.location.kind !== 'DOCX_XML_VALUE') return [];
    return [[nativeRegionIdentity(region), unicodeSlice(artifact.text, region.start, region.end)] as const];
  }));
}

/**
 * Reconciles the current native paragraph/carrier writer against a private
 * staged DOCX. It deliberately returns `independentlyVerified: false` and
 * cannot be used as the application's `docx-redact-v1` attestation. In
 * Independent leakage/fidelity verification remains open.
 */
export async function reconcileDocxStageFoundation(
  source: DocxArtifact,
  staged: StagedTextArtifact,
  plan: TypedLabelPlan,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
): Promise<DocxStageReconciliationFoundation> {
  const sourceState = docxArtifactStates.get(source);
  if (sourceState === undefined) docxVerificationIncomplete('source_state_unavailable');
  try {
    assertTypedLabelPlanIntegrity(plan);
  } catch {
    docxVerificationIncomplete('plan_integrity_mismatch');
  }
  const expectedReceipt = createReceipt(plan, staged);
  if (
    staged.receipt.receiptDigest !== expectedReceipt.receiptDigest
    || staged.receipt.planDigest !== plan.digest
    || staged.receipt.stagedDigest !== staged.digest
    || staged.receipt.stagedByteLength !== staged.byteLength
    || staged.receipt.appliedActionCount !== plan.expectedActionCount
    || staged.receipt.appliedActionIds.length !== plan.actions.length
    || staged.receipt.appliedActionIds.some((id, index) => id !== plan.actions[index]?.id)
  ) docxVerificationIncomplete('receipt_binding_mismatch');

  const assignments = assertPlan(plan, source, sourceState.package);
  const changedParts = new Set<string>();
  for (const part of sourceState.package.parts) {
    if (part.segments.some((segment) => segment.nodes.some((node) => assignments.nodes.has(node)))) changedParts.add(part.name);
  }
  for (const carrier of sourceState.package.carriers) if (assignments.carriers.has(carrier)) changedParts.add(carrier.part);

  let stagedBytes: Buffer;
  try {
    stagedBytes = await fileSystem.readFile(staged.path);
  } catch {
    docxVerificationIncomplete('stage_reopen_failed');
  }
  if (
    stagedBytes.length !== staged.byteLength
    || digestBytes(stagedBytes) !== staged.digest
    || !stagedBytes.equals(applyDocxPlan(source, plan))
  ) docxVerificationIncomplete('writer_byte_mismatch');

  let reopened: DocxArtifact;
  try {
    reopened = await readDocxArtifact(staged.path, defaultMaximumDocxInputBytes, fileSystem);
  } catch {
    docxVerificationIncomplete('package_reopen_failed');
  }
  if (reopened.digest !== staged.digest || reopened.byteLength !== staged.byteLength) {
    docxVerificationIncomplete('reopened_digest_mismatch');
  }
  const reopenedState = docxArtifactStates.get(reopened);
  if (reopenedState === undefined) docxVerificationIncomplete('reopened_state_unavailable');

  if (reopened.text !== expectedCanonicalText(source.text, plan)) {
    docxVerificationIncomplete('canonical_replacement_mismatch');
  }
  const sourceLocations = source.regions.map(nativeRegionIdentity);
  const outputLocations = reopened.regions.map(nativeRegionIdentity);
  if (
    sourceLocations.length !== outputLocations.length
    || sourceLocations.some((identity, index) => identity !== outputLocations[index])
  ) docxVerificationIncomplete('source_map_inventory_mismatch');

  const sourceCarriers = qualifiedCarrierValues(source);
  const outputCarriers = qualifiedCarrierValues(reopened);
  if (
    sourceCarriers.length !== outputCarriers.length
    || sourceState.package.carriers.some((carrier, index) => {
      const candidate = outputCarriers[index];
      const expectedValue = transformCarrier(carrier, assignments.carriers.get(carrier) ?? []);
      return candidate?.[0] !== sourceCarriers[index]?.[0] || candidate?.[1] !== expectedValue;
    })
  ) docxVerificationIncomplete('qualified_carrier_mismatch');

  if (sourceState.entries.length !== reopenedState.entries.length) docxVerificationIncomplete('package_inventory_mismatch');
  let unchangedPartCount = 0;
  for (const [index, inputEntry] of sourceState.entries.entries()) {
    const outputEntry = reopenedState.entries[index];
    if (outputEntry?.name !== inputEntry.name || outputEntry.method !== inputEntry.method) {
      docxVerificationIncomplete('package_inventory_mismatch');
    }
    if (!changedParts.has(inputEntry.name)) {
      if (!outputEntry.contents.equals(inputEntry.contents)) docxVerificationIncomplete('untouched_part_changed');
      unchangedPartCount += 1;
    } else if (outputEntry.contents.equals(inputEntry.contents)) {
      docxVerificationIncomplete('planned_part_unchanged');
    }
  }

  let residualCount = 0;
  let uniqueSourceCanaryCount = 0;
  for (const action of plan.actions) {
    const sourceValue = unicodeSlice(source.text, action.start, action.end);
    const first = source.text.indexOf(sourceValue);
    const unique = sourceValue.length > 0 && first >= 0 && source.text.indexOf(sourceValue, first + 1) < 0;
    if (!unique) continue;
    uniqueSourceCanaryCount += 1;
    if (sourceValue === action.replacement || reopened.text.includes(sourceValue)) residualCount += 1;
  }
  if (residualCount > 0) {
    throw new SafeError({
      code: 'VERIFICATION_RESIDUAL',
      message: 'The staged DOCX artifact retained one or more uniquely planted planned-source canaries.',
      retryable: false,
      correlationId: 'cor_docx_adapter',
      details: { findingCount: residualCount }
    });
  }

  return Object.freeze({
    outcome: 'RECONCILED_NONINDEPENDENT',
    checks: Object.freeze([
      'PLAN_AND_RECEIPT_BINDING',
      'WRITER_BYTE_REPRODUCTION',
      'ZIP_AND_OOXML_REOPEN',
      'CANONICAL_REPLACEMENT_RECONCILIATION',
      'QUALIFIED_CARRIER_RECONCILIATION',
      'UNTOUCHED_PART_CONTENT_IDENTITY',
      'UNIQUE_PLANNED_SOURCE_CANARY_SCAN'
    ] as const),
    expectedActionCount: plan.expectedActionCount,
    appliedActionCount: staged.receipt.appliedActionCount,
    retainedCarrierCount: sourceCarriers.length,
    changedPartCount: changedParts.size,
    unchangedPartCount,
    uniqueSourceCanaryCount,
    independentlyVerified: false,
    fidelityVerified: false
  });
}

async function stageBinary(
  source: DocxArtifact,
  targetPath: string,
  bytes: Buffer,
  plan: TypedLabelPlan,
  fileSystem: TextArtifactFileSystem
): Promise<StagedTextArtifact> {
  const target = resolve(targetPath);
  if (target === source.path) throw new SafeError({ code: 'OUTPUT_COLLISION', message: 'The output path must be different from the input path.', retryable: false, correlationId: 'cor_docx_adapter' });
  try {
    await fileSystem.stat(target);
    throw new SafeError({ code: 'OUTPUT_COLLISION', message: 'The output path already exists.', retryable: false, correlationId: 'cor_docx_adapter' });
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    if (!isMissing(error)) throw storageUnavailable('The DOCX output location could not be checked.');
  }
  const temporary = resolve(dirname(target), `.${basename(target, '.docx')}.${randomUUID()}.staged.docx`);
  let handle;
  try {
    handle = await fileSystem.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch {
    throw storageUnavailable('The staged DOCX artifact could not be created.');
  }
  let failed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch {
    failed = true;
  }
  try {
    await handle.close();
  } catch {
    failed = true;
  }
  if (failed) {
    await discardStagedTextArtifact({ path: temporary }, fileSystem);
    throw storageUnavailable('The staged DOCX artifact could not be written.');
  }
  let written: Buffer;
  try {
    written = await fileSystem.readFile(temporary);
  } catch {
    await discardStagedTextArtifact({ path: temporary }, fileSystem);
    throw storageUnavailable('The staged DOCX artifact could not be verified.');
  }
  if (!written.equals(bytes)) {
    await discardStagedTextArtifact({ path: temporary }, fileSystem);
    throw new SafeError({ code: 'STORAGE_UNAVAILABLE', message: 'The derived DOCX artifact failed digest verification.', retryable: true, correlationId: 'cor_docx_adapter' });
  }
  const base = { reference: temporary, path: temporary, targetPath: target, byteLength: written.length, digest: digestBytes(written) };
  return Object.freeze({ ...base, receipt: createReceipt(plan, base) });
}

export function createLocalDocxArtifactSession(
  inputPath: string,
  outputPath?: string,
  maximumInputBytes = defaultMaximumDocxInputBytes,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
) {
  if (!Number.isSafeInteger(maximumInputBytes) || maximumInputBytes < 0 || maximumInputBytes > defaultMaximumDocxInputBytes) {
    throw new TypeError('Maximum DOCX input bytes must be within the adapter limit.');
  }
  let sourcePromise: Promise<DocxArtifact> | undefined;
  const input = async (signal?: AbortSignal): Promise<DocxArtifact> => {
    signal?.throwIfAborted();
    sourcePromise ??= readDocxArtifact(inputPath, maximumInputBytes, fileSystem);
    const source = await sourcePromise;
    signal?.throwIfAborted();
    return source;
  };
  return {
    writer: docxWriterDescriptor,
    input,
    async stage(plan: TypedLabelPlan, signal?: AbortSignal): Promise<StagedTextArtifact> {
      signal?.throwIfAborted();
      const source = await input(signal);
      const target = outputPath === undefined ? deriveRedactedOutputPath(source.path) : resolve(outputPath);
      if (extname(target).toLowerCase() !== '.docx') {
        throw new SafeError({ code: 'FORMAT_UNSUPPORTED', message: 'A DOCX output path must use the .docx extension.', retryable: false, correlationId: 'cor_docx_adapter' });
      }
      const bytes = applyDocxPlan(source, plan);
      signal?.throwIfAborted();
      const staged = await stageBinary(source, target, bytes, plan, fileSystem);
      try {
        signal?.throwIfAborted();
      } catch (error: unknown) {
        await discardStagedTextArtifact(staged, fileSystem);
        throw error;
      }
      return staged;
    },
    async reopen(staged: StagedTextArtifact, signal?: AbortSignal): Promise<DocxArtifact> {
      signal?.throwIfAborted();
      const reopened = await readDocxArtifact(staged.path, defaultMaximumDocxInputBytes, fileSystem);
      signal?.throwIfAborted();
      if (reopened.digest !== staged.digest || reopened.byteLength !== staged.byteLength) {
        throw new SafeError({ code: 'ARTIFACT_DIGEST_MISMATCH', message: 'The staged DOCX artifact changed before it could be reopened.', retryable: false, correlationId: 'cor_docx_adapter' });
      }
      return reopened;
    },
    async publish(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifactPublication> {
      const source = await input(signal);
      const published = await publishStagedTextArtifact(source, staged, signal, fileSystem);
      return { reference: published.path, byteLength: published.byteLength, digest: published.digest };
    },
    async discard(staged: StagedTextArtifact, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      await discardStagedTextArtifact(staged, fileSystem);
    }
  };
}
