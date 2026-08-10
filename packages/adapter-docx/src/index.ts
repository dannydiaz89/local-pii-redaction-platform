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

export const docxAdapterVersion = '0.1.0';
export const defaultMaximumDocxInputBytes = 25 * 1024 * 1024;
export const docxWriterDescriptor = Object.freeze({
  id: 'docx-adapter',
  version: docxAdapterVersion,
  digest: parseSha256Digest('sha256:ebd569376f51a0fd9d844fd5e9345c7ef2ce44b807ff568119f2632fdd852a9f')
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
    { id: 'fragmented-run-source-map', status: 'SUPPORTED' },
    { id: 'unicode-code-point-offsets', status: 'SUPPORTED' },
    { id: 'native-reopen', status: 'SUPPORTED' },
    { id: 'macros-and-active-content', status: 'BLOCKED' },
    { id: 'external-relationships', status: 'BLOCKED' },
    { id: 'metadata-and-additional-text-parts', status: 'BLOCKED' },
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
const maximumParagraphs = 50_000;
const maximumTextNodes = 100_000;
const maximumXmlElements = 250_000;
const maximumXmlDepth = 128;
const maximumXmlAttributes = 16;
const maximumXmlTagCodeUnits = 32 * 1024;
const maximumCanonicalCodePoints = 10_000_000;
const maximumPlanActions = 100_000;
const actionIdPattern = /^act_[0-9A-HJKMNP-TV-Z]{26}$/u;
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationshipPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
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

function featureUnsupported(): never {
  throw new SafeError({
    code: 'FORMAT_UNSUPPORTED',
    message: 'The DOCX input contains a feature outside this adapter’s declared safe text surface.',
    retryable: false,
    correlationId: 'cor_docx_adapter'
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
      (versionMadeBy >>> 8) !== 0 || flags !== 0x0800 || (method !== 0 && method !== 8)
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
      || localExtraLength !== 0
    ) formatCorrupt();
    if (!bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) formatCorrupt();
    const compressedStart = localOffset + 30 + localNameLength;
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
    if (!Number.isSafeInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) formatCorrupt();
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
  if (xml.includes('\u0000') || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/iu.test(xml)) formatCorrupt();
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
      if (top !== 'w:t' && top !== 'w:instrText' && top !== 'w:delText') formatCorrupt();
    }
    if (xml.startsWith('<!--', openingStart)) featureUnsupported();
    if (xml.startsWith('<?', openingStart)) {
      const end = xml.indexOf('?>', openingStart + 2);
      if (end < 0 || sawDeclaration || openingStart !== 0 || !xml.startsWith('<?xml', openingStart)) formatCorrupt();
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

interface ParagraphRegion {
  readonly paragraphNumber: number;
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly nodes: readonly TextNodeRegion[];
}

interface ParsedDocumentXml {
  readonly xml: string;
  readonly canonicalText: string;
  readonly paragraphs: readonly ParagraphRegion[];
  readonly extractionRevision: Sha256Digest;
}

const blockedDocumentTags = new Set([
  'w:altChunk', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:br', 'w:commentRangeStart', 'w:commentRangeEnd',
  'w:commentReference', 'w:cr', 'w:customXml', 'w:del', 'w:delText', 'w:drawing', 'w:fldChar', 'w:fldSimple',
  'w:hyperlink', 'w:ins', 'w:instrText', 'w:moveFrom', 'w:moveFromRangeStart', 'w:moveFromRangeEnd',
  'w:moveTo', 'w:moveToRangeStart', 'w:moveToRangeEnd', 'w:noBreakHyphen', 'w:object', 'w:oleObject',
  'w:pict', 'w:ptab', 'w:sdt', 'w:softHyphen', 'w:sym', 'w:tab', 'w:txbxContent', 'w:vanish', 'w:webHidden'
]);

const allowedDocumentParents: Readonly<Record<string, readonly (string | undefined)[]>> = {
  'w:document': [undefined],
  'w:body': ['w:document'],
  'w:p': ['w:body', 'w:tc'],
  'w:pPr': ['w:p'],
  'w:r': ['w:p'],
  'w:rPr': ['w:r'],
  'w:t': ['w:r'],
  'w:b': ['w:rPr'],
  'w:i': ['w:rPr'],
  'w:tbl': ['w:body', 'w:tc'],
  'w:tblPr': ['w:tbl'],
  'w:tblGrid': ['w:tbl'],
  'w:gridCol': ['w:tblGrid'],
  'w:tr': ['w:tbl'],
  'w:trPr': ['w:tr'],
  'w:tc': ['w:tr'],
  'w:tcPr': ['w:tc'],
  'w:sectPr': ['w:body']
};

function parseDocumentXml(bytes: Buffer): ParsedDocumentXml {
  const xml = decodeUtf8Xml(bytes);
  const elements = scanXml(xml);
  const root = elements.find((element) => !element.closing);
  if (root?.name !== 'w:document' || root.attributes['xmlns:w'] !== wordNamespace) formatCorrupt();
  for (const element of elements) {
    if (element.name.includes(':') && !element.name.startsWith('w:')) featureUnsupported();
    if (blockedDocumentTags.has(element.name)) featureUnsupported();
    const allowedParents = allowedDocumentParents[element.name];
    if (allowedParents === undefined || (!element.closing && !allowedParents.includes(element.parent))) {
      featureUnsupported();
    }
    if (element.closing) continue;
    const attributeEntries = Object.entries(element.attributes);
    const firstAttribute = attributeEntries[0];
    if (element.name === 'w:document') {
      if (attributeEntries.length !== 1 || firstAttribute?.[0] !== 'xmlns:w' || firstAttribute[1] !== wordNamespace) featureUnsupported();
    } else if (element.name === 'w:t') {
      if (attributeEntries.length > 1 || (attributeEntries.length === 1 && (firstAttribute?.[0] !== 'xml:space' || firstAttribute[1] !== 'preserve'))) featureUnsupported();
    } else if (attributeEntries.length > 0) featureUnsupported();
  }

  const provisional: Array<{ readonly values: Array<{ readonly rawStart: number; readonly rawEnd: number; readonly value: string; readonly preservesWhitespace: boolean }> }> = [];
  let currentParagraph: Array<{ readonly rawStart: number; readonly rawEnd: number; readonly value: string; readonly preservesWhitespace: boolean }> | undefined;
  let textOpening: XmlElement | undefined;
  let textNodeCount = 0;
  for (const element of elements) {
    if (!element.closing && element.name === 'w:p') {
      if (currentParagraph !== undefined) formatCorrupt();
      if (provisional.length >= maximumParagraphs) formatCorrupt();
      currentParagraph = [];
    } else if (element.closing && element.name === 'w:p') {
      if (currentParagraph === undefined || textOpening !== undefined) formatCorrupt();
      provisional.push({ values: currentParagraph });
      currentParagraph = undefined;
    } else if (!element.closing && element.name === 'w:t') {
      if (currentParagraph === undefined || textOpening !== undefined || element.selfClosing) formatCorrupt();
      textOpening = element;
    } else if (element.closing && element.name === 'w:t') {
      if (textOpening === undefined || currentParagraph === undefined) formatCorrupt();
      if (textNodeCount >= maximumTextNodes) formatCorrupt();
      const rawStart = textOpening.openingEnd;
      const rawEnd = element.openingStart;
      const rawValue = xml.slice(rawStart, rawEnd);
      if (rawValue.includes('<')) formatCorrupt();
      currentParagraph.push({
        rawStart,
        rawEnd,
        value: decodeXml(rawValue),
        preservesWhitespace: textOpening.attributes['xml:space'] === 'preserve'
      });
      textNodeCount += 1;
      textOpening = undefined;
    }
  }
  if (currentParagraph !== undefined || textOpening !== undefined) formatCorrupt();

  const canonicalParts: string[] = [];
  const paragraphs: ParagraphRegion[] = [];
  let canonicalLength = 0;
  const hash = createHash('sha256').update('local-pii:docx-extraction:v1\u0000', 'utf8');
  for (const [paragraphIndex, paragraph] of provisional.entries()) {
    if (paragraph.values.length === 0) continue;
    if (paragraphs.length > 0) {
      canonicalParts.push(paragraphBoundary);
      canonicalLength += unicodeCodePointLength(paragraphBoundary);
    }
    const paragraphStart = canonicalLength;
    hash.update(`P:${String(paragraphs.length)}:`, 'utf8');
    const nodes: TextNodeRegion[] = [];
    for (const value of paragraph.values) {
      const canonicalStart = canonicalLength;
      canonicalLength += unicodeCodePointLength(value.value);
      if (canonicalLength > maximumCanonicalCodePoints) formatCorrupt();
      canonicalParts.push(value.value);
      nodes.push(Object.freeze({ ...value, canonicalStart, canonicalEnd: canonicalLength }));
      hash.update('N:', 'utf8').update(String(Buffer.byteLength(value.value, 'utf8')), 'utf8').update(':', 'utf8').update(value.value, 'utf8');
    }
    paragraphs.push(Object.freeze({
      paragraphNumber: paragraphIndex + 1,
      canonicalStart: paragraphStart,
      canonicalEnd: canonicalLength,
      nodes: Object.freeze(nodes)
    }));
  }
  return {
    xml,
    canonicalText: canonicalParts.join(''),
    paragraphs: Object.freeze(paragraphs),
    extractionRevision: parseSha256Digest(`sha256:${hash.digest('hex')}`)
  };
}

function elementsByName(xml: string, expectedRoot: string): readonly XmlElement[] {
  const elements = scanXml(xml);
  const root = elements.find((element) => !element.closing);
  if (root?.name !== expectedRoot) formatCorrupt();
  return elements;
}

const allowedAuxiliaryParts: Readonly<Record<string, string>> = Object.freeze({});

function validatePackage(entries: readonly ZipEntry[]): ParsedDocumentXml {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const allowed = new Set(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', ...Object.keys(allowedAuxiliaryParts)]);
  for (const entry of entries) if (!allowed.has(entry.name)) featureUnsupported();
  const contentTypesEntry = byName.get('[Content_Types].xml');
  const rootRelsEntry = byName.get('_rels/.rels');
  const documentEntry = byName.get('word/document.xml');
  if (contentTypesEntry === undefined || rootRelsEntry === undefined || documentEntry === undefined) formatCorrupt();

  const contentTypesXml = decodeUtf8Xml(contentTypesEntry.contents);
  const contentElements = elementsByName(contentTypesXml, 'Types');
  const contentRoot = contentElements.find((element) => !element.closing);
  if (contentRoot?.attributes.xmlns !== contentTypesNamespace || Object.keys(contentRoot.attributes).length !== 1) formatCorrupt();
  let documentTypeFound = false;
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
    } else if (element.attributes.PartName === '/word/document.xml') {
      if (Object.keys(element.attributes).length !== 2 || contentType !== docxMediaType || documentTypeFound) formatCorrupt();
      documentTypeFound = true;
    } else featureUnsupported();
  }
  if (!documentTypeFound || !relsDefaultFound || !xmlDefaultFound) formatCorrupt();

  const rootRelsXml = decodeUtf8Xml(rootRelsEntry.contents);
  const rootRelationships = elementsByName(rootRelsXml, 'Relationships');
  const rootRelsRoot = rootRelationships.find((element) => !element.closing);
  if (rootRelsRoot?.attributes.xmlns !== relationshipNamespace || Object.keys(rootRelsRoot.attributes).length !== 1) formatCorrupt();
  let officeDocumentFound = false;
  for (const element of rootRelationships) {
    if (element.closing || element.name === 'Relationships') continue;
    if (element.name !== 'Relationship' || !element.selfClosing || element.attributes.TargetMode === 'External') featureUnsupported();
    if (
      Object.keys(element.attributes).length !== 3 || !/^rId[1-9][0-9]{0,5}$/u.test(element.attributes.Id ?? '')
      || element.attributes.Type !== `${officeRelationshipPrefix}officeDocument`
      || element.attributes.Target !== 'word/document.xml' || officeDocumentFound
    ) featureUnsupported();
    officeDocumentFound = true;
  }
  if (!officeDocumentFound) formatCorrupt();

  const relatedParts = new Set<string>();
  const documentRels = byName.get('word/_rels/document.xml.rels');
  if (documentRels !== undefined) {
    const relationships = elementsByName(decodeUtf8Xml(documentRels.contents), 'Relationships');
    const relsRoot = relationships.find((element) => !element.closing);
    if (relsRoot?.attributes.xmlns !== relationshipNamespace || Object.keys(relsRoot.attributes).length !== 1) formatCorrupt();
    for (const element of relationships) {
      if (element.closing || element.name === 'Relationships') continue;
      if (
        element.name !== 'Relationship' || !element.selfClosing || element.attributes.TargetMode === 'External'
        || Object.keys(element.attributes).length !== 3 || !/^rId[1-9][0-9]{0,5}$/u.test(element.attributes.Id ?? '')
      ) featureUnsupported();
      const type = element.attributes.Type;
      const target = element.attributes.Target;
      if (type === undefined || target === undefined || target.startsWith('/') || target.includes('\\') || target.split('/').includes('..')) featureUnsupported();
      const expectedKind = allowedAuxiliaryParts[`word/${target}`];
      if (expectedKind === undefined || type !== `${officeRelationshipPrefix}${expectedKind}`) featureUnsupported();
      if (!byName.has(`word/${target}`) || relatedParts.has(`word/${target}`)) formatCorrupt();
      relatedParts.add(`word/${target}`);
    }
  }
  for (const part of Object.keys(allowedAuxiliaryParts)) {
    if (byName.has(part) !== relatedParts.has(part)) formatCorrupt();
  }
  return parseDocumentXml(documentEntry.contents);
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
  readonly document: ParsedDocumentXml;
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
  const document = validatePackage(entries);
  const artifact: DocxArtifact = Object.freeze({
    reference: path,
    path,
    displayName: basename(path),
    mediaType: docxMediaType,
    byteLength: bytes.length,
    digest: digestBytes(bytes),
    extractionRevision: document.extractionRevision,
    canonicalText: document.canonicalText,
    text: document.canonicalText,
    hasUtf8Bom: false,
    regions: Object.freeze(document.paragraphs.map((paragraph): CanonicalRegionV1 => Object.freeze({
      schemaVersion: '1.0.0',
      start: paragraph.canonicalStart,
      end: paragraph.canonicalEnd,
      offsetUnit: 'UNICODE_CODE_POINT',
      role: 'VALUE',
      location: Object.freeze({
        schemaVersion: '1.0.0',
        kind: 'DOCX_PART',
        part: 'word/document.xml',
        paragraph: paragraph.paragraphNumber
      })
    })))
  });
  docxArtifactStates.set(artifact, { entries, document });
  return artifact;
}

function assertPlan(plan: TypedLabelPlan, source: DocxArtifact, paragraphs: readonly ParagraphRegion[]): Map<TextNodeRegion, TypedLabelAction[]> {
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
    ) throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan actions are invalid.', retryable: false, correlationId: 'cor_docx_adapter' });
    ids.add(action.id);
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if ((sorted[index - 1]?.end ?? 0) > (sorted[index]?.start ?? 0)) {
      throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan contains overlapping actions.', retryable: false, correlationId: 'cor_docx_adapter' });
    }
  }
  const assignments = new Map<TextNodeRegion, TypedLabelAction[]>();
  let paragraphIndex = 0;
  for (const action of sorted) {
    let paragraph = paragraphs[paragraphIndex];
    while (paragraph !== undefined && action.start >= paragraph.canonicalEnd) paragraph = paragraphs[++paragraphIndex];
    if (paragraph === undefined || action.start < paragraph.canonicalStart || action.end > paragraph.canonicalEnd) {
      throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'A redaction action crosses a DOCX paragraph boundary.', retryable: false, correlationId: 'cor_docx_adapter' });
    }
    for (const node of paragraph.nodes) {
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
  const assignments = assertPlan(plan, source, state.document.paragraphs);
  const changed = [...assignments.entries()].sort(([left], [right]) => left.rawStart - right.rawStart);
  const parts: string[] = [];
  let cursor = 0;
  for (const [node, actions] of changed) {
    parts.push(state.document.xml.slice(cursor, node.rawStart), encodeXmlText(transformNode(node, actions)));
    cursor = node.rawEnd;
  }
  parts.push(state.document.xml.slice(cursor));
  const documentBytes = Buffer.from(parts.join(''), 'utf8');
  const outputEntries = state.entries.map((entry) => entry.name === 'word/document.xml' ? Object.freeze({ ...entry, contents: documentBytes }) : entry);
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
