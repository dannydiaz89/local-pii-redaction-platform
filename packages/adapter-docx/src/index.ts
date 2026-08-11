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
import { SafeError, parseSha256Digest, unicodeCodePointLength, type CanonicalRegionV1, type Sha256Digest } from '@local-pii/domain';
import { assertTypedLabelPlanIntegrity, type TypedLabelAction, type TypedLabelPlan } from '@local-pii/redaction';

export const docxAdapterVersion = '0.3.0';
export const defaultMaximumDocxInputBytes = 25 * 1024 * 1024;
export const docxWriterDescriptor = Object.freeze({
  id: 'docx-adapter',
  version: docxAdapterVersion,
  digest: parseSha256Digest('sha256:3970e0046133d3605f4caa257e9d0b5fcf5d322715637d06f13d1d1ac1c83617')
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
    { id: 'strict-passive-theme-and-empty-web-settings-parts', status: 'SUPPORTED' },
    { id: 'fragmented-run-source-map', status: 'SUPPORTED' },
    { id: 'unicode-code-point-offsets', status: 'SUPPORTED' },
    { id: 'native-reopen', status: 'SUPPORTED' },
    { id: 'deflate-compression-option-flags', status: 'SUPPORTED' },
    { id: 'opc-growth-hint-extra-field', status: 'SUPPORTED' },
    { id: 'macros-and-active-content', status: 'BLOCKED' },
    { id: 'external-relationships', status: 'BLOCKED' },
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
const maximumPlanActions = 100_000;
const actionIdPattern = /^act_[0-9A-HJKMNP-TV-Z]{26}$/u;
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationshipPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const officeRelationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const docxMediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const paragraphBoundary = '\n\u0000\n';

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
  readonly parent?: string;
  readonly openingStart: number;
  readonly openingEnd: number;
  readonly closing: boolean;
  readonly selfClosing: boolean;
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

function parseAttributes(source: string): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {};
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
    cursor = end + 1;
  }
  return Object.freeze(attributes);
}

function scanXml(xml: string): readonly XmlElement[] {
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
      if (top !== 'w:t') featureUnsupported('unknown_feature');
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
    const attributes = closing ? Object.freeze({}) : parseAttributes(body.slice(name.length));
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
      attributes,
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
  readonly xml: string;
  readonly segments: readonly SegmentRegion[];
}

interface ParsedDocxPackage {
  readonly canonicalText: string;
  readonly parts: readonly ParsedTextPart[];
  readonly segments: readonly SegmentRegion[];
  readonly extractionRevision: Sha256Digest;
}

const blockedDocumentTags = new Set([
  'w:altChunk', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:br', 'w:commentRangeStart', 'w:commentRangeEnd',
  'w:commentReference', 'w:cr', 'w:customXml', 'w:del', 'w:delText', 'w:drawing', 'w:fldChar', 'w:fldSimple',
  'w:hyperlink', 'w:ins', 'w:instrText', 'w:moveFrom', 'w:moveFromRangeStart', 'w:moveFromRangeEnd',
  'w:moveTo', 'w:moveToRangeStart', 'w:moveToRangeEnd', 'w:noBreakHyphen', 'w:object', 'w:oleObject',
  'w:pict', 'w:ptab', 'w:sdt', 'w:softHyphen', 'w:sym', 'w:txbxContent', 'w:vanish', 'w:webHidden'
]);

const commonTextParents: Readonly<Record<string, readonly string[]>> = {
  'w:pPr': ['w:p'],
  'w:r': ['w:p'],
  'w:rPr': ['w:r'],
  'w:t': ['w:r'],
  'w:tab': ['w:r'],
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
  readonly xml: string;
  readonly segments: readonly RawSegment[];
  readonly referencedHeaderFooterKinds: ReadonlyMap<string, 'header' | 'footer'>;
  readonly referencedFootnoteIds: ReadonlySet<number>;
  readonly referencedEndnoteIds: ReadonlySet<number>;
  readonly declaredNoteIds: ReadonlySet<number>;
  readonly paragraphCount: number;
  readonly textNodeCount: number;
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
    ...(descriptor.root === 'w:document' ? { 'w:body': ['w:document'], 'w:sectPr': ['w:body'], 'w:headerReference': ['w:sectPr'], 'w:footerReference': ['w:sectPr'] } : {}),
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
  const elements = scanXml(xml);
  const root = elements.find((element) => !element.closing);
  if (root?.name !== descriptor.root || root.attributes['xmlns:w'] !== wordNamespace) formatCorrupt();
  const allowedParents = allowedParentsFor(descriptor);
  const referencedHeaderFooterKinds = new Map<string, 'header' | 'footer'>();
  const referencedFootnoteIds = new Set<number>();
  const referencedEndnoteIds = new Set<number>();
  const declaredNoteIds = new Set<number>();
  const specialNoteIds = new Set<number>();
  let activeSpecialNote: { readonly type: 'separator' | 'continuationSeparator'; markerSeen: boolean } | undefined;
  for (const element of elements) {
    if (element.name === 'mc:AlternateContent' || element.name === 'w:drawing' || element.name === 'w:pict') {
      featureUnsupported('drawing_or_alternate_content');
    }
    if (element.name.includes(':') && !element.name.startsWith('w:')) featureUnsupported('unknown_feature');
    if (blockedDocumentTags.has(element.name)) featureUnsupported('unknown_feature');
    const parents = allowedParents[element.name];
    if (parents === undefined || (!element.closing && !parents.includes(element.parent))) {
      featureUnsupported('unknown_feature');
    }
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
      const allowedRootAttributes = descriptor.root === 'w:document'
        ? new Set(['xmlns:w', 'xmlns:r'])
        : new Set(['xmlns:w']);
      if (
        attributeEntries.some(([name]) => !allowedRootAttributes.has(name))
        || (root.attributes['xmlns:r'] !== undefined && root.attributes['xmlns:r'] !== officeRelationshipNamespace)
      ) featureUnsupported('unknown_feature');
    } else if (element.name === 'w:t') {
      if (activeSpecialNote !== undefined) featureUnsupported('unknown_feature');
      if (attributeEntries.length > 1 || (attributeEntries.length === 1 && (firstAttribute?.[0] !== 'xml:space' || firstAttribute[1] !== 'preserve'))) featureUnsupported('unknown_feature');
    } else if (element.name === 'w:tab') {
      if (!element.selfClosing || attributeEntries.length > 0) featureUnsupported('unknown_feature');
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
    } else if (attributeEntries.length > 0) featureUnsupported('unknown_feature');
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
    } else if (!element.closing && (element.name === 'w:tab' || element.name === 'w:footnoteReference' || element.name === 'w:endnoteReference')) {
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
    xml,
    segments: Object.freeze(provisional),
    referencedHeaderFooterKinds,
    referencedFootnoteIds,
    referencedEndnoteIds,
    declaredNoteIds,
    paragraphCount: paragraphNumber,
    textNodeCount
  };
}

function assembleTextParts(parts: readonly ParsedTextPartRaw[]): ParsedDocxPackage {
  if (parts.reduce((total, part) => total + part.paragraphCount, 0) > maximumParagraphs) formatCorrupt();
  if (parts.reduce((total, part) => total + part.textNodeCount, 0) > maximumTextNodes) formatCorrupt();
  const canonicalParts: string[] = [];
  const parsedParts: ParsedTextPart[] = [];
  const segments: SegmentRegion[] = [];
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
    }
    parsedParts.push(Object.freeze({ name: part.descriptor.name, xml: part.xml, segments: Object.freeze(partSegments) }));
  }
  return {
    canonicalText: canonicalParts.join(''),
    parts: Object.freeze(parsedParts),
    segments: Object.freeze(segments),
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
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  r: officeRelationshipNamespace,
  sl: 'http://schemas.openxmlformats.org/schemaLibrary/2006/main',
  o: 'urn:schemas-microsoft-com:office:office',
  v: 'urn:schemas-microsoft-com:vml',
  w10: 'urn:schemas-microsoft-com:office:word',
  w: wordNamespace,
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  w16cex: 'http://schemas.microsoft.com/office/word/2018/wordml/cex',
  w16cid: 'http://schemas.microsoft.com/office/word/2016/wordml/cid',
  w16: 'http://schemas.microsoft.com/office/word/2018/wordml',
  w16sdtdh: 'http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash',
  w16sdtfl: 'http://schemas.microsoft.com/office/word/2024/wordml/sdtformatlock',
  w16se: 'http://schemas.microsoft.com/office/word/2015/wordml/symex',
  w16du: 'http://schemas.microsoft.com/office/word/2023/wordml/word16du'
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

const supportedPartPattern = /^word\/(?:header[1-9][0-9]{0,5}|footer[1-9][0-9]{0,5}|footnotes|endnotes)\.xml$/u;
const relationshipKinds: Readonly<Record<string, { readonly root: TextPartDescriptor['root']; readonly contentType: string; readonly target: RegExp }>> = Object.freeze({
  header: { root: 'w:hdr', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml', target: /^header[1-9][0-9]{0,5}\.xml$/u },
  footer: { root: 'w:ftr', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml', target: /^footer[1-9][0-9]{0,5}\.xml$/u },
  footnotes: { root: 'w:footnotes', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml', target: /^footnotes\.xml$/u },
  endnotes: { root: 'w:endnotes', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml', target: /^endnotes\.xml$/u }
});

const passiveRelationshipKinds: Readonly<Record<string, { readonly target: string; readonly part: string; readonly contentType: string }>> = Object.freeze({
  theme: { target: 'theme/theme1.xml', part: 'word/theme/theme1.xml', contentType: 'application/vnd.openxmlformats-officedocument.theme+xml' },
  webSettings: { target: 'webSettings.xml', part: 'word/webSettings.xml', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml' },
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

function validatePackage(entries: readonly ZipEntry[]): ParsedDocxPackage {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const fixed = new Set(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels']);
  for (const entry of entries) {
    if (!fixed.has(entry.name) && !supportedPartPattern.test(entry.name) && passivePartProfiles[entry.name] === undefined) {
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
      ) featureUnsupported(unsupportedEntryReason(normalized));
      declaredTypes.set(normalized, contentType);
    }
  }
  if (declaredTypes.get('word/document.xml') !== docxMediaType || !relsDefaultFound || !xmlDefaultFound) formatCorrupt();

  const rootRelsXml = decodeUtf8Xml(rootRelsEntry.contents);
  const rootRelationships = elementsByName(rootRelsXml, 'Relationships');
  const rootRelsRoot = rootRelationships.find((element) => !element.closing);
  if (rootRelsRoot?.attributes.xmlns !== relationshipNamespace || Object.keys(rootRelsRoot.attributes).length !== 1) formatCorrupt();
  let officeDocumentFound = false;
  for (const element of rootRelationships) {
    if (element.closing || element.name === 'Relationships') continue;
    if (element.name !== 'Relationship' || !element.selfClosing) featureUnsupported('unknown_feature');
    if (element.attributes.TargetMode === 'External') featureUnsupported('external_relationship');
    if (
      Object.keys(element.attributes).length !== 3 || !/^rId[1-9][0-9]{0,5}$/u.test(element.attributes.Id ?? '')
      || element.attributes.Type !== `${officeRelationshipPrefix}officeDocument`
      || element.attributes.Target !== 'word/document.xml' || officeDocumentFound
    ) featureUnsupported('unknown_feature');
    officeDocumentFound = true;
  }
  if (!officeDocumentFound) formatCorrupt();

  const relatedParts = new Map<string, { readonly id: string; readonly kind: string }>();
  const relatedPassiveParts = new Map<string, { readonly id: string; readonly kind: string }>();
  const relationshipIds = new Set<string>();
  const documentRels = byName.get('word/_rels/document.xml.rels');
  if (documentRels !== undefined) {
    const relationships = elementsByName(decodeUtf8Xml(documentRels.contents), 'Relationships');
    const relsRoot = relationships.find((element) => !element.closing);
    if (relsRoot?.attributes.xmlns !== relationshipNamespace || Object.keys(relsRoot.attributes).length !== 1) formatCorrupt();
    for (const element of relationships) {
      if (element.closing || element.name === 'Relationships') continue;
      if (element.attributes.TargetMode === 'External') featureUnsupported('external_relationship');
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
      && !relatedParts.has(part)
      && !relatedPassiveParts.has(part)
    ) formatCorrupt();
  }

  for (const [part, profile] of Object.entries(passivePartProfiles)) {
    const entry = byName.get(part);
    if (entry !== undefined) validatePassivePart(entry, profile);
  }
  for (const part of Object.keys(passivePartProfiles)) if (byName.has(part) !== relatedPassiveParts.has(part)) formatCorrupt();

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
  const document = rawParts[0];
  if (document === undefined || document.descriptor.name !== 'word/document.xml') formatCorrupt();
  const referenced = document.referencedHeaderFooterKinds;
  for (const [part, relationship] of relatedParts) {
    if ((relationship.kind === 'header' || relationship.kind === 'footer') && referenced.get(relationship.id) !== relationship.kind) formatCorrupt();
    if (referenced.has(relationship.id) && relationship.kind !== 'header' && relationship.kind !== 'footer') formatCorrupt();
    if (!part.startsWith('word/')) formatCorrupt();
  }
  for (const id of referenced.keys()) if (!relationshipIds.has(id)) formatCorrupt();
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
  return assembleTextParts(rawParts);
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
  readonly regions: readonly CanonicalRegionV1[];
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
    regions: Object.freeze(parsedPackage.segments.map((segment): CanonicalRegionV1 => Object.freeze({
      schemaVersion: '1.0.0',
      start: segment.canonicalStart,
      end: segment.canonicalEnd,
      offsetUnit: 'UNICODE_CODE_POINT',
      role: 'VALUE',
      location: Object.freeze({
        schemaVersion: '1.0.0',
        kind: 'DOCX_PART',
        part: segment.part,
        paragraph: segment.paragraphNumber
      })
    })))
  });
  docxArtifactStates.set(artifact, { entries, package: parsedPackage });
  return artifact;
}

function assertPlan(plan: TypedLabelPlan, source: DocxArtifact, segments: readonly SegmentRegion[]): Map<TextNodeRegion, TypedLabelAction[]> {
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
  const assignments = new Map<TextNodeRegion, TypedLabelAction[]>();
  let segmentIndex = 0;
  for (const action of sorted) {
    let segment = segments[segmentIndex];
    while (segment !== undefined && action.start >= segment.canonicalEnd) segment = segments[++segmentIndex];
    if (segment === undefined || action.start < segment.canonicalStart || action.end > segment.canonicalEnd) {
      throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'A redaction action crosses a DOCX structural boundary.', retryable: false, correlationId: 'cor_docx_adapter' });
    }
    for (const node of segment.nodes) {
      if (action.start < node.canonicalEnd && action.end > node.canonicalStart) {
        const assigned = assignments.get(node) ?? [];
        assigned.push(action);
        assignments.set(node, assigned);
      }
    }
  }
  return assignments;
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

function encodeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function applyDocxPlan(source: DocxArtifact, plan: TypedLabelPlan): Buffer {
  const state = docxArtifactStates.get(source);
  if (state === undefined) throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The DOCX extraction state is unavailable.', retryable: false, correlationId: 'cor_docx_adapter' });
  const assignments = assertPlan(plan, source, state.package.segments);
  const rewritten = new Map<string, Buffer>();
  for (const part of state.package.parts) {
    const nodes = part.segments.flatMap((segment) => segment.nodes)
      .filter((node) => assignments.has(node))
      .sort((left, right) => left.rawStart - right.rawStart);
    if (nodes.length === 0) continue;
    const output: string[] = [];
    let cursor = 0;
    for (const node of nodes) {
      output.push(part.xml.slice(cursor, node.rawStart), encodeXmlText(transformNode(node, assignments.get(node) ?? [])));
      cursor = node.rawEnd;
    }
    output.push(part.xml.slice(cursor));
    rewritten.set(part.name, Buffer.from(output.join(''), 'utf8'));
  }
  const outputEntries = state.entries.map((entry) => rewritten.has(entry.name)
    ? Object.freeze({ ...entry, contents: rewritten.get(entry.name) ?? entry.contents })
    : entry);
  return writeZip(outputEntries);
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
