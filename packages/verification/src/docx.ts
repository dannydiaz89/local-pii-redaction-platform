import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { computeWriterReceiptDigest, type RedactionWriterReceiptContract } from '@local-pii/contracts';
import { detectDeterministic } from '@local-pii/detectors';
import {
  parseSha256Digest,
  unicodeCodePointLength,
  type CanonicalRegion,
  type EntityType,
  type Sha256Digest
} from '@local-pii/domain';
import { resolveEvidence } from '@local-pii/span-resolution';

const maximumEntries = 256;
const maximumExpandedBytes = 50 * 1024 * 1024;
const maximumEntryBytes = 10 * 1024 * 1024;
const maximumElements = 250_000;
const maximumDepth = 128;
const maximumAttributes = 64;
const maximumActions = 100_000;
const actionIdPattern = /^act_[0-9A-HJKMNP-TV-Z]{26}$/u;
const relationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const officeRelationshipPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const docxMediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const boundary = '\n\u0000DOCX-INDEPENDENT-CARRIER\u0000\n';

type WriterReceipt = RedactionWriterReceiptContract.WriterReceipt;

export interface IndependentDocxPlanBinding {
  readonly id: string;
  readonly digest: Sha256Digest;
  readonly inputDigest: Sha256Digest;
  readonly extractionRevision: Sha256Digest;
  readonly writer: { readonly id: string; readonly version: string };
  readonly expectedActionCount: number;
  readonly actions: readonly {
    readonly id: string;
    readonly entityType: EntityType;
    readonly start: number;
    readonly end: number;
    readonly replacement: string;
  }[];
}

export interface IndependentDocxVerificationRequest {
  readonly inputBytes: Uint8Array;
  readonly outputBytes: Uint8Array;
  readonly sourceCanonicalText: string;
  readonly sourceRegions: readonly CanonicalRegion[];
  readonly plan: IndependentDocxPlanBinding;
  readonly writerReceipt: WriterReceipt;
}

export type IndependentDocxFindingCode =
  | 'BINDING_MISMATCH'
  | 'PACKAGE_INVALID'
  | 'PACKAGE_INVENTORY_CHANGED'
  | 'CONTENT_TYPE_GRAPH_INVALID'
  | 'RELATIONSHIP_GRAPH_INVALID'
  | 'SOURCE_MAP_MISMATCH'
  | 'UNPLANNED_NATIVE_DELTA'
  | 'PLANNED_NATIVE_DELTA_MISMATCH'
  | 'RESIDUAL_SOURCE_CANARY'
  | 'RESIDUAL_ENTITY'
  | 'VERIFIER_INCOMPLETE';

export interface IndependentDocxVerificationFoundation {
  readonly outcome: 'RECONCILED_SUPPLIED_REGIONS' | 'FAIL' | 'INCOMPLETE';
  readonly checks: readonly [
    'INDEPENDENT_ZIP_INVENTORY',
    'INDEPENDENT_CONTENT_TYPE_GRAPH',
    'INDEPENDENT_RELATIONSHIP_GRAPH',
    'GENERIC_XML_CARRIER_ENUMERATION',
    'SUPPLIED_NATIVE_REGION_RECONCILIATION',
    'ACTION_RECEIPT_RECONCILIATION',
    'INDEPENDENT_RESIDUAL_SCAN'
  ];
  readonly findings: readonly {
    readonly code: IndependentDocxFindingCode;
    readonly count: number;
    readonly entityType?: EntityType;
  }[];
  readonly inputEntryCount: number;
  readonly outputEntryCount: number;
  readonly retainedRegionCount: number;
  readonly genericCarrierCount: number;
  readonly expectedActionCount: number;
  readonly appliedActionCount: number;
  readonly independentParser: true;
  readonly fidelityVerified: false;
  readonly authorizesPublication: false;
}

interface ZipEntry {
  readonly name: string;
  readonly method: 0 | 8;
  readonly contents: Buffer;
}

interface XmlCarrier {
  readonly id: string;
  readonly value: string;
  readonly part: string;
  readonly kind: 'ATTRIBUTE' | 'TEXT';
  readonly element: string;
  readonly elementOrdinal: number;
  readonly attribute?: string;
  readonly paragraph?: number;
  readonly segment?: number;
}

interface ParagraphSegment {
  readonly part: string;
  readonly paragraph: number;
  readonly segment: number;
  readonly value: string;
  readonly carrierIds: readonly string[];
}

interface XmlElementRecord {
  readonly name: string;
  readonly ordinal: number;
  readonly parent?: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly selfClosing: boolean;
}

interface ParsedXmlPart {
  readonly structureDigest: Sha256Digest;
  readonly carriers: readonly XmlCarrier[];
  readonly paragraphs: readonly ParagraphSegment[];
  readonly elements: readonly XmlElementRecord[];
}

interface ParsedPackage {
  readonly entries: readonly ZipEntry[];
  readonly byName: ReadonlyMap<string, ZipEntry>;
  readonly xml: ReadonlyMap<string, ParsedXmlPart>;
  readonly carriers: readonly XmlCarrier[];
  readonly paragraphs: readonly ParagraphSegment[];
  readonly relationships: ReadonlyMap<string, XmlCarrier>;
}

class VerificationFailure extends Error {
  public constructor(public readonly code: IndependentDocxFindingCode) {
    super(code);
  }
}

function fail(code: IndependentDocxFindingCode): never {
  throw new VerificationFailure(code);
}

function digest(bytes: Uint8Array): Sha256Digest {
  return parseSha256Digest(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

function checked(buffer: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    fail('PACKAGE_INVALID');
  }
}

function u16(buffer: Buffer, offset: number): number {
  checked(buffer, offset, 2);
  return buffer.readUInt16LE(offset);
}

function u32(buffer: Buffer, offset: number): number {
  checked(buffer, offset, 4);
  return buffer.readUInt32LE(offset);
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

function validGrowthHint(extra: Buffer): boolean {
  if (extra.length === 0) return true;
  if (extra.length < 8 || extra.length > 4 * 1024 + 8) return false;
  const padding = extra.subarray(8);
  return u16(extra, 0) === 0xa220 && u16(extra, 2) === extra.length - 4
    && u16(extra, 4) === 0xa028 && u16(extra, 6) === padding.length
    && padding.every((value) => value === 0);
}

function decodeName(bytes: Buffer, utf8: boolean): string {
  if (!utf8 && bytes.some((value) => value > 0x7f)) fail('PACKAGE_INVALID');
  try {
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (
      name.length < 1 || name.length > 240 || name.startsWith('/') || name.endsWith('/')
      || name.includes('\\') || name.includes('\u0000')
      || name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) fail('PACKAGE_INVALID');
    return name;
  } catch {
    return fail('PACKAGE_INVALID');
  }
}

function parseZip(input: Uint8Array): readonly ZipEntry[] {
  const bytes = Buffer.from(input);
  if (bytes.length < 22) fail('PACKAGE_INVALID');
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (u32(bytes, index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0 || u16(bytes, eocd + 20) !== 0 || eocd + 22 !== bytes.length) fail('PACKAGE_INVALID');
  const count = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if (
    count < 1 || count > maximumEntries || u16(bytes, eocd + 8) !== count
    || u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0
    || centralOffset + centralSize !== eocd
  ) fail('PACKAGE_INVALID');
  const entries: ZipEntry[] = [];
  const localRanges: Array<readonly [number, number]> = [];
  const names = new Set<string>();
  const folded = new Set<string>();
  let expandedTotal = 0;
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, cursor) !== 0x02014b50) fail('PACKAGE_INVALID');
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    const expectedCrc = u32(bytes, cursor + 16);
    const compressedSize = u32(bytes, cursor + 20);
    const expandedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    checked(bytes, cursor, 46 + nameLength + extraLength + commentLength);
    if (
      (flags & ~0x0806) !== 0 || (method !== 0 && method !== 8) || extraLength !== 0 || commentLength !== 0
      || u16(bytes, cursor + 34) !== 0 || u16(bytes, cursor + 36) !== 0 || u32(bytes, cursor + 38) !== 0
      || expandedSize > maximumEntryBytes || expandedTotal + expandedSize > maximumExpandedBytes
      || expandedSize > compressedSize * 100 + 1024
    ) fail('PACKAGE_INVALID');
    expandedTotal += expandedSize;
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeName(nameBytes, (flags & 0x0800) !== 0);
    const casefold = name.toLocaleLowerCase('en-US');
    if (names.has(name) || folded.has(casefold)) fail('PACKAGE_INVALID');
    names.add(name);
    folded.add(casefold);
    if (u32(bytes, localOffset) !== 0x04034b50) fail('PACKAGE_INVALID');
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    if (
      u16(bytes, localOffset + 6) !== flags || u16(bytes, localOffset + 8) !== method
      || u32(bytes, localOffset + 14) !== expectedCrc || u32(bytes, localOffset + 18) !== compressedSize
      || u32(bytes, localOffset + 22) !== expandedSize || localNameLength !== nameLength
    ) fail('PACKAGE_INVALID');
    checked(bytes, localOffset + 30, localNameLength + localExtraLength + compressedSize);
    if (!bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) fail('PACKAGE_INVALID');
    const localExtra = bytes.subarray(localOffset + 30 + localNameLength, localOffset + 30 + localNameLength + localExtraLength);
    if (!validGrowthHint(localExtra)) fail('PACKAGE_INVALID');
    const compressedStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(compressedStart, compressedStart + compressedSize);
    let contents: Buffer;
    try {
      contents = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: maximumEntryBytes });
    } catch {
      return fail('PACKAGE_INVALID');
    }
    if (contents.length !== expandedSize || crc32(contents) !== expectedCrc) fail('PACKAGE_INVALID');
    localRanges.push([localOffset, compressedStart + compressedSize]);
    entries.push(Object.freeze({ name, method, contents }));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  localRanges.sort((left, right) => left[0] - right[0]);
  if (
    cursor !== eocd || localRanges[0]?.[0] !== 0 || localRanges.at(-1)?.[1] !== centralOffset
    || localRanges.some((range, index) => index > 0 && localRanges[index - 1]?.[1] !== range[0])
  ) fail('PACKAGE_INVALID');
  return Object.freeze(entries);
}

function xmlCodePoint(codePoint: number): boolean {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function decodeEntities(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#x[0-9A-Fa-f]+|#[0-9]+);)/u.test(value)) fail('PACKAGE_INVALID');
  return value.replace(/&(?:amp|lt|gt|quot|apos|#x[0-9A-Fa-f]+|#[0-9]+);/gu, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const codePoint = entity.startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number.parseInt(entity.slice(2, -1), 10);
    if (!Number.isSafeInteger(codePoint) || !xmlCodePoint(codePoint)) fail('PACKAGE_INVALID');
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
    if (match === null) fail('PACKAGE_INVALID');
    const name = match[0];
    cursor += name.length;
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor++] !== '=') fail('PACKAGE_INVALID');
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    const quote = source[cursor++];
    if (quote !== '"' && quote !== "'") fail('PACKAGE_INVALID');
    const end = source.indexOf(quote, cursor);
    if (end < 0 || Object.hasOwn(attributes, name) || Object.keys(attributes).length >= maximumAttributes) fail('PACKAGE_INVALID');
    const rawValue = source.slice(cursor, end);
    if (rawValue.includes('<')) fail('PACKAGE_INVALID');
    attributes[name] = decodeEntities(rawValue);
    cursor = end + 1;
  }
  return Object.freeze(attributes);
}

function decodeXml(bytes: Buffer): string {
  try {
    const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
    const value = new TextDecoder('utf-8', { fatal: true }).decode(body);
    for (const character of value) if (!xmlCodePoint(character.codePointAt(0) ?? 0)) fail('PACKAGE_INVALID');
    return value;
  } catch (error: unknown) {
    if (error instanceof VerificationFailure) throw error;
    return fail('PACKAGE_INVALID');
  }
}

function parseXml(part: string, bytes: Buffer): ParsedXmlPart {
  const xml = decodeXml(bytes);
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<!--/iu.test(xml)) fail('PACKAGE_INVALID');
  const ordinals = new Map<string, number>();
  const paragraphOrdinals = new Map<string, number>();
  const stack: Array<{
    readonly name: string;
    readonly ordinal: number;
    text: string;
    readonly paragraph?: number;
    segment?: number;
  }> = [];
  const elements: XmlElementRecord[] = [];
  const carriers: XmlCarrier[] = [];
  const paragraphValues = new Map<string, { parts: string[]; carrierIds: string[] }>();
  const structure = createHash('sha256').update('local-pii:independent-docx-structure:v1\u0000');
  let cursor = 0;
  let sawDeclaration = false;
  let roots = 0;
  while (cursor < xml.length) {
    const opening = xml.indexOf('<', cursor);
    if (opening < 0) {
      if (xml.slice(cursor).trim().length > 0) fail('PACKAGE_INVALID');
      break;
    }
    const rawText = xml.slice(cursor, opening);
    if (rawText.length > 0) {
      const frame = stack.at(-1);
      if (frame === undefined) {
        if (rawText.trim().length > 0) fail('PACKAGE_INVALID');
      } else frame.text += decodeEntities(rawText);
    }
    if (xml.startsWith('<?', opening)) {
      const end = xml.indexOf('?>', opening + 2);
      const declaration = end < 0 ? '' : xml.slice(opening, end + 2);
      if (sawDeclaration || opening !== 0 || !/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"(?:UTF-8|utf-8)"|'(?:UTF-8|utf-8)'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/u.test(declaration)) fail('PACKAGE_INVALID');
      sawDeclaration = true;
      structure.update(`D:${declaration}\u0000`);
      cursor = end + 2;
      continue;
    }
    let end = opening + 1;
    let quote: string | undefined;
    while (end < xml.length) {
      const character = xml[end];
      if (quote !== undefined) { if (character === quote) quote = undefined; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      end += 1;
    }
    if (end >= xml.length) fail('PACKAGE_INVALID');
    const raw = xml.slice(opening + 1, end);
    const closing = raw.startsWith('/');
    const selfClosing = !closing && /\/\s*$/u.test(raw);
    const body = closing ? raw.slice(1).trim() : raw.replace(/\/\s*$/u, '').trim();
    const name = /^[A-Za-z_][A-Za-z0-9_.:-]*/u.exec(body)?.[0];
    if (name === undefined) fail('PACKAGE_INVALID');
    if (closing) {
      if (body !== name) fail('PACKAGE_INVALID');
      const frame = stack.pop();
      if (frame?.name !== name) fail('PACKAGE_INVALID');
      const value = frame.text;
      if (value.length > 0) {
        const id = `T\u0000${part}\u0000${name}\u0000${String(frame.ordinal)}`;
        const paragraphFrame = [...stack].reverse().find((candidate) => candidate.name === 'w:p');
        const paragraph = paragraphFrame?.paragraph;
        const segment = paragraphFrame?.segment;
        carriers.push(Object.freeze({ id, value, part, kind: 'TEXT', element: name, elementOrdinal: frame.ordinal, ...(paragraph === undefined ? {} : { paragraph }), ...(segment === undefined ? {} : { segment }) }));
        if (name === 'w:t' && paragraph !== undefined && segment !== undefined) {
          const key = `${part}\u0000${String(paragraph)}\u0000${String(segment)}`;
          const aggregate = paragraphValues.get(key) ?? { parts: [], carrierIds: [] };
          aggregate.parts.push(value);
          aggregate.carrierIds.push(id);
          paragraphValues.set(key, aggregate);
        }
      }
      structure.update(`C:${name}\u0000`);
      cursor = end + 1;
      continue;
    }
    const attributes = parseAttributes(body.slice(name.length));
    const ordinal = (ordinals.get(name) ?? 0) + 1;
    ordinals.set(name, ordinal);
    const parent = stack.at(-1)?.name;
    let paragraph: number | undefined;
    let segment: number | undefined;
    if (name === 'w:p') {
      paragraph = (paragraphOrdinals.get(part) ?? 0) + 1;
      paragraphOrdinals.set(part, paragraph);
      segment = 1;
    } else {
      const paragraphFrame = [...stack].reverse().find((candidate) => candidate.name === 'w:p');
      paragraph = paragraphFrame?.paragraph;
      segment = paragraphFrame?.segment;
      if (paragraphFrame !== undefined && (name === 'w:tab' || name === 'w:footnoteReference' || name === 'w:endnoteReference')) {
        paragraphFrame.segment = (paragraphFrame.segment ?? 1) + 1;
      }
    }
    elements.push(Object.freeze({ name, ordinal, ...(parent === undefined ? {} : { parent }), attributes, selfClosing }));
    for (const [attribute, value] of Object.entries(attributes)) {
      if (attribute === 'xmlns' || attribute.startsWith('xmlns:')) continue;
      carriers.push(Object.freeze({
        id: `A\u0000${part}\u0000${name}\u0000${String(ordinal)}\u0000${attribute}`,
        value, part, kind: 'ATTRIBUTE', element: name, elementOrdinal: ordinal, attribute,
        ...(paragraph === undefined ? {} : { paragraph }), ...(segment === undefined ? {} : { segment })
      }));
    }
    const namespaceBindings = Object.entries(attributes)
      .filter(([attribute]) => attribute === 'xmlns' || attribute.startsWith('xmlns:'))
      .map(([attribute, value]) => [attribute, value] as const);
    structure.update(`O:${name}:${parent ?? ''}:${JSON.stringify(Object.keys(attributes))}:${JSON.stringify(namespaceBindings)}:${selfClosing ? '1' : '0'}\u0000`);
    if (stack.length === 0) roots += 1;
    if (!selfClosing) {
      if (stack.length >= maximumDepth) fail('PACKAGE_INVALID');
      stack.push({ name, ordinal, text: '', ...(paragraph === undefined ? {} : { paragraph }), ...(segment === undefined ? {} : { segment }) });
    }
    if (elements.length > maximumElements || roots > 1) fail('PACKAGE_INVALID');
    cursor = end + 1;
  }
  if (stack.length !== 0 || roots !== 1) fail('PACKAGE_INVALID');
  const paragraphs = [...paragraphValues.entries()].map(([key, aggregate]) => {
    const [paragraphPart, paragraph, segment] = key.split('\u0000');
    return Object.freeze({
      part: paragraphPart ?? '', paragraph: Number(paragraph), segment: Number(segment),
      value: aggregate.parts.join(''), carrierIds: Object.freeze(aggregate.carrierIds)
    });
  }).sort((left, right) => left.part.localeCompare(right.part) || left.paragraph - right.paragraph || left.segment - right.segment);
  return Object.freeze({
    structureDigest: parseSha256Digest(`sha256:${structure.digest('hex')}`),
    carriers: Object.freeze(carriers),
    paragraphs: Object.freeze(paragraphs),
    elements: Object.freeze(elements)
  });
}

function relationshipSourcePart(relsPart: string): string | undefined {
  if (relsPart === '_rels/.rels') return '';
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/u.exec(relsPart);
  return match === null ? undefined : `${match[1] ?? ''}/${match[2] ?? ''}`;
}

function resolveInternalTarget(sourcePart: string, target: string): string {
  if (target.startsWith('/') || target.includes('\\') || target.includes('\u0000')) fail('RELATIONSHIP_GRAPH_INVALID');
  const base = sourcePart === '' ? '' : posix.dirname(sourcePart);
  const resolved = posix.normalize(posix.join(base, target));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) fail('RELATIONSHIP_GRAPH_INVALID');
  return resolved;
}

function validateContentTypes(parsed: ParsedPackage): void {
  const content = parsed.xml.get('[Content_Types].xml');
  const root = content?.elements.at(0);
  if (content === undefined || root?.name !== 'Types' || root.attributes.xmlns !== contentTypesNamespace) {
    fail('CONTENT_TYPE_GRAPH_INVALID');
  }
  let rels = false;
  let xml = false;
  let document = false;
  const declared = new Set<string>();
  for (const element of content.elements.slice(1)) {
    if (element.name === 'Default') {
      if (element.attributes.Extension === 'rels' && element.attributes.ContentType === 'application/vnd.openxmlformats-package.relationships+xml') rels = true;
      else if (element.attributes.Extension === 'xml' && element.attributes.ContentType === 'application/xml') xml = true;
      else fail('CONTENT_TYPE_GRAPH_INVALID');
    } else if (element.name === 'Override') {
      const part = element.attributes.PartName;
      const type = element.attributes.ContentType;
      if (part === undefined || type === undefined || !part.startsWith('/') || declared.has(part)) fail('CONTENT_TYPE_GRAPH_INVALID');
      declared.add(part);
      if (part === '/word/document.xml' && (type === docxMediaType || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) document = true;
      if (!parsed.byName.has(part.slice(1))) fail('CONTENT_TYPE_GRAPH_INVALID');
    } else fail('CONTENT_TYPE_GRAPH_INVALID');
  }
  if (!rels || !xml || !document) fail('CONTENT_TYPE_GRAPH_INVALID');
}

function validateRelationships(parsed: ParsedPackage): ReadonlyMap<string, XmlCarrier> {
  const relationships = new Map<string, XmlCarrier>();
  let officeDocumentCount = 0;
  for (const [part, xml] of parsed.xml) {
    if (!part.endsWith('.rels')) continue;
    const sourcePart = relationshipSourcePart(part);
    const root = xml.elements.at(0);
    if (sourcePart === undefined || root?.name !== 'Relationships' || root.attributes.xmlns !== relationshipNamespace) {
      fail('RELATIONSHIP_GRAPH_INVALID');
    }
    if (sourcePart !== '' && !parsed.byName.has(sourcePart)) fail('RELATIONSHIP_GRAPH_INVALID');
    const ids = new Set<string>();
    for (const element of xml.elements.slice(1)) {
      if (element.name !== 'Relationship' || !element.selfClosing) fail('RELATIONSHIP_GRAPH_INVALID');
      const id = element.attributes.Id;
      const type = element.attributes.Type;
      const target = element.attributes.Target;
      if (id === undefined || type === undefined || target === undefined || ids.has(id)) fail('RELATIONSHIP_GRAPH_INVALID');
      ids.add(id);
      const targetMode = element.attributes.TargetMode;
      if (targetMode === 'External') {
        if (type !== `${officeRelationshipPrefix}hyperlink` || !/^(?:https:\/\/|mailto:)/iu.test(target)) fail('RELATIONSHIP_GRAPH_INVALID');
        try {
          const url = new URL(target);
          if ((url.protocol !== 'https:' && url.protocol !== 'mailto:') || (url.protocol === 'https:' && url.hostname.length === 0)) fail('RELATIONSHIP_GRAPH_INVALID');
        } catch (error: unknown) {
          if (error instanceof VerificationFailure) throw error;
          fail('RELATIONSHIP_GRAPH_INVALID');
        }
      } else {
        if (targetMode !== undefined || !parsed.byName.has(resolveInternalTarget(sourcePart, target))) fail('RELATIONSHIP_GRAPH_INVALID');
        if (sourcePart === '' && type === `${officeRelationshipPrefix}officeDocument` && target === 'word/document.xml') officeDocumentCount += 1;
      }
      const genericId = `A\u0000${part}\u0000Relationship\u0000${String(element.ordinal)}\u0000Target`;
      const carrier = xml.carriers.find(({ id: candidate }) => candidate === genericId);
      if (carrier === undefined) fail('RELATIONSHIP_GRAPH_INVALID');
      relationships.set(`R\u0000${sourcePart}\u0000${id}`, carrier);
    }
  }
  if (officeDocumentCount !== 1) fail('RELATIONSHIP_GRAPH_INVALID');
  return relationships;
}

function parsePackage(bytes: Uint8Array): ParsedPackage {
  const entries = parseZip(bytes);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const xml = new Map<string, ParsedXmlPart>();
  for (const entry of entries) {
    if (entry.name.endsWith('.xml') || entry.name.endsWith('.rels')) xml.set(entry.name, parseXml(entry.name, entry.contents));
  }
  const preliminary: ParsedPackage = {
    entries, byName, xml,
    carriers: Object.freeze([...xml.values()].flatMap(({ carriers }) => carriers)),
    paragraphs: Object.freeze([...xml.values()].flatMap(({ paragraphs }) => paragraphs)),
    relationships: new Map()
  };
  validateContentTypes(preliminary);
  const relationships = validateRelationships(preliminary);
  return Object.freeze({ ...preliminary, relationships });
}

function codePointToUtf16(value: string, target: number): number {
  let utf16 = 0;
  let codePoints = 0;
  while (utf16 < value.length && codePoints < target) {
    utf16 += (value.codePointAt(utf16) ?? 0) > 0xffff ? 2 : 1;
    codePoints += 1;
  }
  if (codePoints !== target) fail('SOURCE_MAP_MISMATCH');
  return utf16;
}

function unicodeSlice(value: string, start: number, end: number): string {
  return value.slice(codePointToUtf16(value, start), codePointToUtf16(value, end));
}

interface ResolvedRegion {
  readonly value: string;
  readonly carrierIds: readonly string[];
}

function resolveRegions(parsed: ParsedPackage, regions: readonly CanonicalRegion[]): readonly ResolvedRegion[] {
  const occurrences = new Map<string, number>();
  return regions.map((region) => {
    const location = region.location;
    if (location.kind === 'DOCX_PART') {
      const identity = `${location.part}\u0000${String(location.paragraph)}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      const candidates = parsed.paragraphs.filter(({ part, paragraph }) => part === location.part && paragraph === location.paragraph);
      const candidate = candidates[occurrence];
      if (candidate === undefined) fail('SOURCE_MAP_MISMATCH');
      return { value: candidate.value, carrierIds: candidate.carrierIds };
    }
    if (location.kind === 'DOCX_RELATIONSHIP') {
      const carrier = parsed.relationships.get(`R\u0000${location.sourcePart}\u0000${location.relationshipId}`);
      if (carrier === undefined || (location as unknown as { readonly field?: unknown }).field !== 'TARGET') fail('SOURCE_MAP_MISMATCH');
      return { value: carrier.value, carrierIds: [carrier.id] };
    }
    if (location.kind === 'DOCX_XML_VALUE') {
      const id = location.carrier === 'ATTRIBUTE'
        ? `A\u0000${location.part}\u0000${location.element}\u0000${String(location.elementOrdinal)}\u0000${location.attribute ?? ''}`
        : `T\u0000${location.part}\u0000${location.element}\u0000${String(location.elementOrdinal)}`;
      const carrier = parsed.carriers.find(({ id: candidate }) => candidate === id);
      if (carrier === undefined) fail('SOURCE_MAP_MISMATCH');
      return { value: carrier.value, carrierIds: [id] };
    }
    return fail('SOURCE_MAP_MISMATCH');
  });
}

function validateBindings(request: IndependentDocxVerificationRequest, inputDigest: Sha256Digest, outputDigest: Sha256Digest): void {
  const { plan, writerReceipt: receipt } = request;
  if (
    plan.inputDigest !== inputDigest || plan.expectedActionCount !== plan.actions.length
    || plan.actions.length > maximumActions || new Set(plan.actions.map(({ id }) => id)).size !== plan.actions.length
    || plan.actions.some(({ id, start, end, replacement }, index) => {
      const previous = index === 0 ? undefined : plan.actions.at(index - 1);
      return !actionIdPattern.test(id) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end <= start || typeof replacement !== 'string'
        || (index > 0 && (previous === undefined || start < previous.end));
    })
    || (receipt as unknown as { readonly schemaVersion?: unknown }).schemaVersion !== '1.0.0'
    || receipt.planDigest !== plan.digest || receipt.stagedDigest !== outputDigest
    || receipt.stagedByteLength !== request.outputBytes.byteLength || receipt.writer.id !== plan.writer.id || receipt.writer.version !== plan.writer.version
    || receipt.expectedActionCount !== plan.expectedActionCount || receipt.appliedActionCount !== plan.actions.length
    || receipt.appliedActionIds.length !== plan.actions.length || receipt.appliedActionIds.some((id, index) => id !== plan.actions[index]?.id)
  ) fail('BINDING_MISMATCH');
  try {
    const { receiptDigest, ...unsigned } = receipt;
    if (computeWriterReceiptDigest(unsigned) !== receiptDigest) fail('BINDING_MISMATCH');
  } catch {
    fail('BINDING_MISMATCH');
  }
}

function expectedRegionValue(value: string, region: CanonicalRegion, actions: readonly IndependentDocxPlanBinding['actions'][number][]): string {
  const output: string[] = [];
  let cursor = region.start;
  for (const action of actions) {
    if (action.start < region.start || action.end > region.end) fail('SOURCE_MAP_MISMATCH');
    output.push(unicodeSlice(value, cursor - region.start, action.start - region.start), action.replacement);
    cursor = action.end;
  }
  output.push(unicodeSlice(value, cursor - region.start, region.end - region.start));
  return output.join('');
}

function expectedParagraphCarrierValues(
  parsed: ParsedPackage,
  resolved: ResolvedRegion,
  region: CanonicalRegion,
  actions: readonly IndependentDocxPlanBinding['actions'][number][]
): ReadonlyMap<string, string> {
  const expected = new Map<string, string>();
  let carrierStart = region.start;
  for (const id of resolved.carrierIds) {
    const carrier = parsed.carriers.find(({ id: candidate }) => candidate === id);
    if (carrier === undefined) fail('SOURCE_MAP_MISMATCH');
    const carrierEnd = carrierStart + unicodeCodePointLength(carrier.value);
    const output: string[] = [];
    let cursor = carrierStart;
    for (const action of actions) {
      if (action.start >= carrierEnd || action.end <= carrierStart) continue;
      const overlapStart = Math.max(action.start, carrierStart);
      const overlapEnd = Math.min(action.end, carrierEnd);
      if (overlapStart > cursor) output.push(unicodeSlice(carrier.value, cursor - carrierStart, overlapStart - carrierStart));
      if (action.start >= carrierStart && action.start < carrierEnd) output.push(action.replacement);
      cursor = Math.max(cursor, overlapEnd);
    }
    if (cursor < carrierEnd) output.push(unicodeSlice(carrier.value, cursor - carrierStart, carrierEnd - carrierStart));
    expected.set(id, output.join(''));
    carrierStart = carrierEnd;
  }
  if (carrierStart !== region.end) fail('SOURCE_MAP_MISMATCH');
  return expected;
}

function report(
  outcome: IndependentDocxVerificationFoundation['outcome'],
  findings: IndependentDocxVerificationFoundation['findings'],
  counts: Partial<Pick<IndependentDocxVerificationFoundation, 'inputEntryCount' | 'outputEntryCount' | 'retainedRegionCount' | 'genericCarrierCount' | 'expectedActionCount' | 'appliedActionCount'>> = {}
): IndependentDocxVerificationFoundation {
  return Object.freeze({
    outcome,
    checks: Object.freeze([
      'INDEPENDENT_ZIP_INVENTORY', 'INDEPENDENT_CONTENT_TYPE_GRAPH', 'INDEPENDENT_RELATIONSHIP_GRAPH',
      'GENERIC_XML_CARRIER_ENUMERATION', 'SUPPLIED_NATIVE_REGION_RECONCILIATION',
      'ACTION_RECEIPT_RECONCILIATION', 'INDEPENDENT_RESIDUAL_SCAN'
    ] as const),
    findings: Object.freeze(findings),
    inputEntryCount: counts.inputEntryCount ?? 0,
    outputEntryCount: counts.outputEntryCount ?? 0,
    retainedRegionCount: counts.retainedRegionCount ?? 0,
    genericCarrierCount: counts.genericCarrierCount ?? 0,
    expectedActionCount: counts.expectedActionCount ?? 0,
    appliedActionCount: counts.appliedActionCount ?? 0,
    independentParser: true,
    fidelityVerified: false,
    authorizesPublication: false
  });
}

/**
 * Independently parses and reconciles a strict DOCX input/output pair without
 * importing or invoking the DOCX adapter. This is a non-authorizing foundation:
 * renderer fidelity, sandboxing, malicious-corpus qualification, and a bound
 * application attestation remain mandatory before DOCX publication can be enabled.
 */
export function verifyIndependentDocxFoundation(request: IndependentDocxVerificationRequest): IndependentDocxVerificationFoundation {
  const counts = {
    expectedActionCount: Number.isSafeInteger(request.plan.expectedActionCount) ? request.plan.expectedActionCount : 0,
    appliedActionCount: Number.isSafeInteger(request.writerReceipt.appliedActionCount) ? request.writerReceipt.appliedActionCount : 0,
    retainedRegionCount: Array.isArray(request.sourceRegions) ? request.sourceRegions.length : 0
  };
  try {
    const inputDigest = digest(request.inputBytes);
    const outputDigest = digest(request.outputBytes);
    validateBindings(request, inputDigest, outputDigest);
    const input = parsePackage(request.inputBytes);
    const output = parsePackage(request.outputBytes);
    const detailedCounts = { ...counts, inputEntryCount: input.entries.length, outputEntryCount: output.entries.length, genericCarrierCount: output.carriers.length };
    if (
      input.entries.length !== output.entries.length
      || input.entries.some((entry, index) => {
        const candidate = output.entries.at(index);
        return candidate === undefined || entry.name !== candidate.name || entry.method !== candidate.method;
      })
    ) fail('PACKAGE_INVENTORY_CHANGED');
    for (const [part, inputXml] of input.xml) {
      if (output.xml.get(part)?.structureDigest !== inputXml.structureDigest) fail('UNPLANNED_NATIVE_DELTA');
    }
    const inputRegions = resolveRegions(input, request.sourceRegions);
    const outputRegions = resolveRegions(output, request.sourceRegions);
    const expectedCarrierValues = new Map(input.carriers.map((carrier) => [carrier.id, carrier.value]));
    let actionIndex = 0;
    for (const [index, region] of request.sourceRegions.entries()) {
      const inputRegion = inputRegions[index];
      const outputRegion = outputRegions[index];
      if (inputRegion === undefined || outputRegion === undefined) fail('SOURCE_MAP_MISMATCH');
      const claimed = unicodeSlice(request.sourceCanonicalText, region.start, region.end);
      if (inputRegion.value !== claimed) fail('SOURCE_MAP_MISMATCH');
      const actions: IndependentDocxPlanBinding['actions'][number][] = [];
      while ((request.plan.actions[actionIndex]?.start ?? Number.POSITIVE_INFINITY) < region.end) {
        const action = request.plan.actions[actionIndex];
        if (action === undefined || action.start < region.start || action.end > region.end) fail('SOURCE_MAP_MISMATCH');
        actions.push(action);
        actionIndex += 1;
      }
      if (outputRegion.value !== expectedRegionValue(inputRegion.value, region, actions)) fail('PLANNED_NATIVE_DELTA_MISMATCH');
      if (actions.length > 0) {
        const carrierValues = inputRegion.carrierIds.length === 1
          ? new Map([[inputRegion.carrierIds[0] ?? '', expectedRegionValue(inputRegion.value, region, actions)]])
          : expectedParagraphCarrierValues(input, inputRegion, region, actions);
        for (const [id, value] of carrierValues) {
          if (id.length === 0 || !expectedCarrierValues.has(id)) fail('SOURCE_MAP_MISMATCH');
          expectedCarrierValues.set(id, value);
        }
      }
    }
    if (actionIndex !== request.plan.actions.length) fail('SOURCE_MAP_MISMATCH');
    const outputCarrierMap = new Map(output.carriers.map((carrier) => [carrier.id, carrier]));
    if (input.carriers.length !== output.carriers.length) fail('UNPLANNED_NATIVE_DELTA');
    for (const carrier of input.carriers) {
      const candidate = outputCarrierMap.get(carrier.id);
      if (candidate === undefined || candidate.value !== expectedCarrierValues.get(carrier.id)) fail('UNPLANNED_NATIVE_DELTA');
    }
    for (const [index, entry] of input.entries.entries()) {
      const outputEntry = output.entries[index];
      if (outputEntry === undefined) fail('PACKAGE_INVENTORY_CHANGED');
      if (!input.xml.has(entry.name) && !entry.contents.equals(outputEntry.contents)) fail('UNPLANNED_NATIVE_DELTA');
    }
    const paragraphCarrierIds = new Set(output.paragraphs.flatMap(({ carrierIds }) => carrierIds));
    const retainedValues = [
      ...output.paragraphs.map(({ value }) => value),
      ...output.carriers.filter(({ id }) => !paragraphCarrierIds.has(id)).map(({ value }) => value)
    ];
    let canaryCount = 0;
    const outputCarrierText = retainedValues.join(boundary);
    for (const action of request.plan.actions) {
      const source = unicodeSlice(request.sourceCanonicalText, action.start, action.end);
      const first = request.sourceCanonicalText.indexOf(source);
      const unique = source.length > 0 && first >= 0 && request.sourceCanonicalText.indexOf(source, first + 1) < 0;
      if (unique && outputCarrierText.includes(source)) canaryCount += 1;
    }
    const findings: Array<{ readonly code: IndependentDocxFindingCode; readonly count: number; readonly entityType?: EntityType }> = [];
    if (canaryCount > 0) findings.push({ code: 'RESIDUAL_SOURCE_CANARY', count: canaryCount });
    const rescannedText = retainedValues.join(boundary);
    const evidence = detectDeterministic(rescannedText, outputDigest);
    const resolution = resolveEvidence(evidence, outputDigest, unicodeCodePointLength(rescannedText));
    if (resolution.conflicts.length > 0) fail('VERIFIER_INCOMPLETE');
    const byEntity = new Map<EntityType, number>();
    for (const span of resolution.spans) byEntity.set(span.entityType, (byEntity.get(span.entityType) ?? 0) + 1);
    for (const [entityType, count] of byEntity) findings.push({ code: 'RESIDUAL_ENTITY', count, entityType });
    return report(findings.length === 0 ? 'RECONCILED_SUPPLIED_REGIONS' : 'FAIL', findings, detailedCounts);
  } catch (error: unknown) {
    const code = error instanceof VerificationFailure ? error.code : 'VERIFIER_INCOMPLETE';
    return report(code === 'RESIDUAL_SOURCE_CANARY' || code === 'RESIDUAL_ENTITY' ? 'FAIL' : 'INCOMPLETE', [{ code, count: 1 }], counts);
  }
}
