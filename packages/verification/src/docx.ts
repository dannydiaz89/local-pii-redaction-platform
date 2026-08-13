import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { computeWriterReceiptDigest, isRfc3339DateTime, type RedactionWriterReceiptContract } from '@local-pii/contracts';
import { detectDeterministic } from '@local-pii/detectors';
import {
  entityTypes,
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
const planIdPattern = /^plan_[0-9A-HJKMNP-TV-Z]{26}$/u;
const sourceSpanIdPattern = /^rsp_[a-f0-9]{32}$/u;
const versionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const componentIdPattern = /^[a-z][a-z0-9-]{2,63}$/u;
const relationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const officeRelationshipPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const docxMediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const paragraphBoundary = '\n\u0000\n';
const carrierBoundary = '\n\u0000DOCX-CARRIER\u0000\n';
const boundary = '\n\u0000DOCX-INDEPENDENT-CARRIER\u0000\n';

type WriterReceipt = RedactionWriterReceiptContract.WriterReceipt;

export interface IndependentDocxPlanBinding {
  readonly id: string;
  readonly digest: Sha256Digest;
  readonly inputDigest: Sha256Digest;
  readonly extractionRevision: Sha256Digest;
  readonly capabilityDigest: Sha256Digest;
  readonly policy: {
    readonly id: string;
    readonly version: string;
    readonly digest: Sha256Digest;
    readonly riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  };
  readonly writer: { readonly id: string; readonly version: string };
  readonly expectedActionCount: number;
  readonly actions: readonly {
    readonly id: string;
    readonly sourceSpanId?: string;
    readonly entityType: EntityType;
    readonly start: number;
    readonly end: number;
    readonly replacement: string;
  }[];
  readonly review?: {
    readonly extractionRevision: Sha256Digest;
    readonly revision: number;
    readonly decisionCount: number;
    readonly digest: Sha256Digest;
    readonly decisions: readonly {
      readonly sourceSpanId: string;
      readonly action: 'ACCEPT' | 'REJECT' | 'RETYPE';
      readonly entityType: EntityType;
      readonly reviewedEntityType?: EntityType;
      readonly start: number;
      readonly end: number;
    }[];
  };
}

export interface IndependentDocxApplicationBinding {
  readonly capabilityDigest: Sha256Digest;
  readonly policy: IndependentDocxPlanBinding['policy'];
  readonly writer: { readonly id: string; readonly version: string; readonly digest: Sha256Digest };
  readonly application: { readonly id: string; readonly version: string; readonly digest: Sha256Digest };
  readonly outputMediaType: typeof docxMediaType;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface IndependentDocxVerificationRequest {
  readonly inputBytes: Uint8Array;
  readonly outputBytes: Uint8Array;
  readonly sourceCanonicalText: string;
  readonly sourceRegions: readonly CanonicalRegion[];
  readonly plan: IndependentDocxPlanBinding;
  readonly writerReceipt: WriterReceipt;
  readonly applicationBinding: IndependentDocxApplicationBinding;
}

export type IndependentDocxFindingCode =
  | 'BINDING_MISMATCH'
  | 'PACKAGE_INVALID'
  | 'PACKAGE_INVENTORY_CHANGED'
  | 'CONTENT_TYPE_GRAPH_INVALID'
  | 'RELATIONSHIP_GRAPH_INVALID'
  | 'CARRIER_CLASSIFICATION_MISMATCH'
  | 'EXTRACTION_REVISION_MISMATCH'
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
    'INDEPENDENT_SOURCE_CARRIER_CLASSIFICATION',
    'INDEPENDENT_EXTRACTION_REVISION',
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
  readonly classifiedRegionCount: number;
  readonly genericCarrierCount: number;
  readonly expectedActionCount: number;
  readonly appliedActionCount: number;
  readonly reviewedResidualCount: number;
  readonly suppliedApplicationInputsBound: boolean;
  readonly suppliedApplicationBindingDigest?: Sha256Digest;
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
      if (
        paragraphFrame !== undefined
        && ((name === 'w:tab' && parent === 'w:r') || name === 'w:footnoteReference' || name === 'w:endnoteReference')
      ) {
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
  const rawParagraphs = [...paragraphValues.entries()].map(([key, aggregate]) => {
    const [paragraphPart, paragraph, segment] = key.split('\u0000');
    return Object.freeze({
      part: paragraphPart ?? '', paragraph: Number(paragraph), segment: Number(segment),
      value: aggregate.parts.join(''), carrierIds: Object.freeze(aggregate.carrierIds)
    });
  }).sort((left, right) => left.part.localeCompare(right.part) || left.paragraph - right.paragraph || left.segment - right.segment);
  const normalizedSegments = new Map<string, number>();
  const paragraphs = rawParagraphs.map((paragraph) => {
    const identity = `${paragraph.part}\u0000${String(paragraph.paragraph)}`;
    const segment = (normalizedSegments.get(identity) ?? 0) + 1;
    normalizedSegments.set(identity, segment);
    return Object.freeze({ ...paragraph, segment });
  });
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

const textPartPattern = /^word\/(?:document|header[1-9][0-9]{0,5}|footer[1-9][0-9]{0,5}|footnotes|endnotes)\.xml$/u;
const classifiedAttributePartPattern = /^(?:word\/(?:document|header[1-9][0-9]{0,5}|footer[1-9][0-9]{0,5}|footnotes|endnotes|settings|numbering|styles|fontTable)\.xml|customXml\/(?:item1|itemProps1)\.xml|docProps\/(?:core|app)\.xml)$/u;
const propertyTextElements = new Set([
  'dc:creator', 'dc:description', 'dc:language', 'dc:subject', 'dc:title', 'dcterms:created', 'dcterms:modified',
  'cp:lastModifiedBy', 'cp:lastPrinted', 'cp:revision', 'Template', 'TotalTime', 'Pages', 'Words', 'Characters',
  'Application', 'DocSecurity', 'Lines', 'Paragraphs', 'ScaleCrop', 'Company', 'LinksUpToDate',
  'CharactersWithSpaces', 'SharedDoc', 'HyperlinksChanged', 'AppVersion', 'vt:lpstr', 'vt:i4'
]);

const structuralCarrierPairs = new Set([
  'w:t|xml:space', 'w:headerReference|r:id', 'w:headerReference|w:type', 'w:footerReference|r:id',
  'w:footerReference|w:type', 'w:hyperlink|r:id', 'w:footnoteReference|w:id', 'w:endnoteReference|w:id',
  'w:footnote|w:id', 'w:footnote|w:type', 'w:endnote|w:id', 'w:endnote|w:type',
  'w:p|w14:paraId', 'w:p|w14:textId', 'w:p|w:rsidR', 'w:p|w:rsidRDefault', 'w:p|w:rsidP',
  'w:p|w:rsidRPr', 'w:r|w:rsidR', 'w:sectPr|w:rsidR', 'w:rsid|w:val', 'w:rsidRoot|w:val',
  'w:nsid|w:val', 'w:tmpl|w:val', 'w:num|w:numId', 'w:num|w16cid:durableId',
  'w:abstractNum|w:abstractNumId', 'w:abstractNum|w15:restartNumberingAfterBreak', 'w:lvl|w:ilvl',
  'w:start|w:val', 'w:numFmt|w:val', 'w:suff|w:val', 'w:lvlJc|w:val', 'w:outlineLvl|w:val',
  'w:uiPriority|w:val', 'w:sz|w:val', 'w:szCs|w:val', 'w:defaultTabStop|w:val',
  'w:hyphenationZone|w:val', 'w:zoom|w:percent', 'w:ind|w:left', 'w:ind|w:right',
  'w:ind|w:firstLine', 'w:ind|w:hanging', 'w:spacing|w:before', 'w:spacing|w:after',
  'w:spacing|w:line', 'w:spacing|w:lineRule', 'w:tab|w:pos', 'w:tab|w:val', 'w:pgSz|w:w',
  'w:pgSz|w:h', 'w:pgMar|w:top', 'w:pgMar|w:right', 'w:pgMar|w:bottom', 'w:pgMar|w:left',
  'w:pgMar|w:header', 'w:pgMar|w:footer', 'w:pgMar|w:gutter', 'w:docGrid|w:charSpace',
  'w:docGrid|w:linePitch', 'w:cols|w:num', 'w:cols|w:space', 'w:panose1|w:val',
  'w:sig|w:usb0', 'w:sig|w:usb1', 'w:sig|w:usb2', 'w:sig|w:usb3', 'w:sig|w:csb0',
  'w:sig|w:csb1', 'w:color|w:val', 'w:shd|w:fill', 'wp:anchor|distT', 'wp:anchor|distB',
  'wp:anchor|distL', 'wp:anchor|distR', 'wp:anchor|simplePos', 'wp:anchor|relativeHeight',
  'wp:anchor|behindDoc', 'wp:anchor|locked', 'wp:anchor|layoutInCell', 'wp:anchor|allowOverlap',
  'wp:anchor|wp14:anchorId', 'wp:anchor|wp14:editId', 'wp:simplePos|x', 'wp:simplePos|y',
  'wp:extent|cx', 'wp:extent|cy', 'wp:effectExtent|l', 'wp:effectExtent|t', 'wp:effectExtent|r',
  'wp:effectExtent|b', 'wp:docPr|id', 'a:off|x', 'a:off|y', 'a:ext|cx', 'a:ext|cy',
  'a:ln|w', 'a:fillRef|idx', 'a:lnRef|idx', 'a:effectRef|idx', 'a:fontRef|idx',
  'a:prstGeom|prst', 'a:srgbClr|val', 'v:line|wp14:anchorId'
]);

type ClassifiedCarrierLocation =
  | Extract<CanonicalRegion['location'], { readonly kind: 'DOCX_RELATIONSHIP' }>
  | Extract<CanonicalRegion['location'], { readonly kind: 'DOCX_XML_VALUE' }>;

interface ClassifiedCarrier {
  readonly identity: string;
  readonly value: string;
  readonly location: ClassifiedCarrierLocation;
}

interface ClassifiedSource {
  readonly canonicalText: string;
  readonly regions: readonly CanonicalRegion[];
  readonly extractionRevision: Sha256Digest;
}

function textPartRank(name: string): readonly [number, number, string] {
  const rank = name === 'word/document.xml' ? 0 : name.includes('/header') ? 1 : name.includes('/footer') ? 2 : name.endsWith('/footnotes.xml') ? 3 : 4;
  const suffix = Number(/(?:header|footer)([1-9][0-9]*)\.xml$/u.exec(name)?.[1] ?? 0);
  return [rank, suffix, name];
}

function compareTextParts(left: string, right: string): number {
  const a = textPartRank(left);
  const b = textPartRank(right);
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

function classifyCarriers(parsed: ParsedPackage): readonly ClassifiedCarrier[] {
  const carriers: ClassifiedCarrier[] = [];
  for (const [relationshipIdentity, targetCarrier] of parsed.relationships) {
    const fields = relationshipIdentity.split('\u0000');
    const sourcePart = fields[1];
    const relationshipId = fields[2];
    const relationshipXml = parsed.xml.get(targetCarrier.part);
    const relationship = relationshipXml?.elements.find((element) => element.name === 'Relationship' && element.ordinal === targetCarrier.elementOrdinal);
    if (
      sourcePart === undefined || relationshipId === undefined || !textPartPattern.test(sourcePart)
      || relationship?.attributes.TargetMode !== 'External'
      || relationship.attributes.Type !== `${officeRelationshipPrefix}hyperlink`
    ) continue;
    carriers.push(Object.freeze({
      identity: `R\u0000${sourcePart}\u0000${relationshipId}`,
      value: targetCarrier.value,
      location: Object.freeze({
        schemaVersion: '2.0.0', kind: 'DOCX_RELATIONSHIP', sourcePart,
        relationshipId, field: 'TARGET'
      })
    }));
  }
  for (const carrier of parsed.carriers) {
    if (!classifiedAttributePartPattern.test(carrier.part)) continue;
    if (carrier.kind === 'ATTRIBUTE') {
      if (structuralCarrierPairs.has(`${carrier.element}|${carrier.attribute ?? ''}`)) continue;
    } else {
      const retainedText = textPartPattern.test(carrier.part)
        ? carrier.element === 'wp:posOffset' || carrier.element === 'wp:align'
        : carrier.part === 'docProps/core.xml' || carrier.part === 'docProps/app.xml'
          ? propertyTextElements.has(carrier.element)
          : false;
      if (!retainedText || carrier.element === 'w:t') continue;
    }
    const location = Object.freeze({
      schemaVersion: '2.0.0' as const,
      kind: 'DOCX_XML_VALUE' as const,
      part: carrier.part,
      element: carrier.element,
      elementOrdinal: carrier.elementOrdinal,
      carrier: carrier.kind,
      ...(carrier.attribute === undefined ? {} : { attribute: carrier.attribute })
    });
    carriers.push(Object.freeze({
      identity: `X\u0000${carrier.part}\u0000${carrier.element}\u0000${String(carrier.elementOrdinal).padStart(7, '0')}\u0000${carrier.kind}\u0000${carrier.attribute ?? ''}`,
      value: carrier.value,
      location
    }));
  }
  return Object.freeze(carriers.sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0));
}

function classifySource(parsed: ParsedPackage): ClassifiedSource {
  const classifiedCarriers = classifyCarriers(parsed);
  const textParts = [...parsed.xml.keys()].filter((part) => textPartPattern.test(part)).sort(compareTextParts);
  if (textParts[0] !== 'word/document.xml') fail('CARRIER_CLASSIFICATION_MISMATCH');
  const canonical: string[] = [];
  const regions: CanonicalRegion[] = [];
  const hash = createHash('sha256').update('local-pii:docx-extraction:v3\u0000', 'utf8');
  let canonicalLength = 0;
  let segmentCount = 0;
  for (const part of textParts) {
    hash.update(`PART:${part}\u0000`, 'utf8');
    const paragraphs = parsed.paragraphs
      .filter((paragraph) => paragraph.part === part)
      .sort((left, right) => left.paragraph - right.paragraph || left.segment - right.segment);
    for (const paragraph of paragraphs) {
      if (segmentCount > 0) {
        canonical.push(paragraphBoundary);
        canonicalLength += unicodeCodePointLength(paragraphBoundary);
      }
      const start = canonicalLength;
      hash.update(`S:${String(paragraph.paragraph)}:${String(paragraph.segment)}:`, 'utf8');
      for (const id of paragraph.carrierIds) {
        const node = parsed.carriers.find((carrier) => carrier.id === id);
        if (node === undefined || node.element !== 'w:t') fail('CARRIER_CLASSIFICATION_MISMATCH');
        canonical.push(node.value);
        canonicalLength += unicodeCodePointLength(node.value);
        hash.update('N:', 'utf8').update(String(Buffer.byteLength(node.value, 'utf8')), 'utf8').update(':', 'utf8').update(node.value, 'utf8');
      }
      regions.push(Object.freeze({
        schemaVersion: classifiedCarriers.length === 0 ? '1.0.0' : '2.0.0',
        start, end: canonicalLength, offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE',
        location: Object.freeze({ schemaVersion: '1.0.0', kind: 'DOCX_PART', part, paragraph: paragraph.paragraph })
      }));
      segmentCount += 1;
    }
  }
  for (const carrier of classifiedCarriers) {
    if (carrier.value.length === 0) continue;
    if (canonical.length > 0) {
      canonical.push(carrierBoundary);
      canonicalLength += unicodeCodePointLength(carrierBoundary);
    }
    const start = canonicalLength;
    canonical.push(carrier.value);
    canonicalLength += unicodeCodePointLength(carrier.value);
    regions.push(Object.freeze({
      schemaVersion: '2.0.0', start, end: canonicalLength, offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE',
      location: carrier.location
    }));
    hash.update('C:', 'utf8').update(carrier.location.kind, 'utf8').update(':', 'utf8')
      .update(String(Buffer.byteLength(carrier.value, 'utf8')), 'utf8').update(':', 'utf8').update(carrier.value, 'utf8');
  }
  return Object.freeze({
    canonicalText: canonical.join(''),
    regions: Object.freeze(regions),
    extractionRevision: parseSha256Digest(`sha256:${hash.digest('hex')}`)
  });
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

function locationIdentity(location: CanonicalRegion['location']): string {
  if (location.kind === 'DOCX_PART') return `P\u0000${location.schemaVersion}\u0000${location.part}\u0000${String(location.paragraph)}`;
  if (location.kind === 'DOCX_RELATIONSHIP') return `R\u0000${location.schemaVersion}\u0000${location.sourcePart}\u0000${location.relationshipId}\u0000${location.field}`;
  if (location.kind === 'DOCX_XML_VALUE') {
    return `X\u0000${location.schemaVersion}\u0000${location.part}\u0000${location.element}\u0000${String(location.elementOrdinal)}\u0000${location.carrier}\u0000${location.attribute ?? ''}`;
  }
  return 'UNSUPPORTED';
}

function validateClassification(request: IndependentDocxVerificationRequest, classified: ClassifiedSource): void {
  if (classified.canonicalText !== request.sourceCanonicalText || classified.regions.length !== request.sourceRegions.length) {
    fail('CARRIER_CLASSIFICATION_MISMATCH');
  }
  for (const [index, expected] of classified.regions.entries()) {
    const supplied = request.sourceRegions[index];
    if (
      supplied === undefined || supplied.schemaVersion !== expected.schemaVersion
      || supplied.start !== expected.start || supplied.end !== expected.end
      || (supplied as unknown as { readonly offsetUnit?: unknown }).offsetUnit !== 'UNICODE_CODE_POINT'
      || (supplied as unknown as { readonly role?: unknown }).role !== 'VALUE'
      || locationIdentity(supplied.location) !== locationIdentity(expected.location)
      || unicodeSlice(request.sourceCanonicalText, supplied.start, supplied.end) !== unicodeSlice(classified.canonicalText, expected.start, expected.end)
    ) fail('CARRIER_CLASSIFICATION_MISMATCH');
  }
  if (classified.extractionRevision !== request.plan.extractionRevision) fail('EXTRACTION_REVISION_MISMATCH');
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

function validDigest(value: unknown): value is Sha256Digest {
  try { parseSha256Digest(value as string); return true; } catch { return false; }
}

function validComponent(value: { readonly id: unknown; readonly version: unknown; readonly digest: unknown }): boolean {
  return typeof value.id === 'string' && componentIdPattern.test(value.id)
    && typeof value.version === 'string' && versionPattern.test(value.version) && validDigest(value.digest);
}

function validateReviewBinding(plan: IndependentDocxPlanBinding, sourceLength: number): void {
  if (plan.review === undefined) return;
  const review = plan.review;
  if (
    review.extractionRevision !== plan.extractionRevision || !validDigest(review.digest)
    || !Number.isSafeInteger(review.revision) || review.revision < 0 || review.revision > 1000
    || review.decisionCount !== review.revision || review.decisions.length > review.decisionCount
    || plan.actions.some(({ sourceSpanId }) => typeof sourceSpanId !== 'string' || !sourceSpanIdPattern.test(sourceSpanId))
    || new Set(plan.actions.map(({ sourceSpanId }) => sourceSpanId)).size !== plan.actions.length
  ) fail('BINDING_MISMATCH');
  const actionsBySpan = new Map(plan.actions.map((action) => [action.sourceSpanId, action]));
  const seen = new Set<string>();
  let priorEnd = -1;
  for (const decision of review.decisions) {
    const runtimeAction = (decision as unknown as { readonly action?: unknown }).action;
    if (
      typeof runtimeAction !== 'string' || !['ACCEPT', 'REJECT', 'RETYPE'].includes(runtimeAction)
      || !sourceSpanIdPattern.test(decision.sourceSpanId) || seen.has(decision.sourceSpanId)
      || !Number.isSafeInteger(decision.start) || !Number.isSafeInteger(decision.end)
      || decision.start < 0 || decision.end <= decision.start || decision.end > sourceLength || decision.start < priorEnd
      || !entityTypes.includes(decision.entityType)
    ) fail('BINDING_MISMATCH');
    const action = actionsBySpan.get(decision.sourceSpanId);
    if (decision.action === 'REJECT') {
      if (
        action !== undefined || decision.reviewedEntityType !== undefined
        || plan.actions.some((candidate) => candidate.start < decision.end && candidate.end > decision.start)
      ) fail('BINDING_MISMATCH');
    } else {
      const expectedType = decision.action === 'RETYPE' ? decision.reviewedEntityType : decision.entityType;
      if (
        action === undefined || action.start !== decision.start || action.end !== decision.end
        || action.entityType !== expectedType
        || (decision.action === 'ACCEPT' && decision.reviewedEntityType !== undefined)
      ) fail('BINDING_MISMATCH');
    }
    seen.add(decision.sourceSpanId);
    priorEnd = decision.end;
  }
}

function permittedReviewedResiduals(plan: IndependentDocxPlanBinding): ReadonlySet<string> {
  const allowed = new Set<string>();
  if (plan.review === undefined) return allowed;
  const actions = [...plan.actions].sort((left, right) => left.start - right.start);
  for (const decision of plan.review.decisions) {
    if (decision.action !== 'REJECT') continue;
    let delta = 0;
    for (const action of actions) {
      if (action.end > decision.start) break;
      delta += unicodeCodePointLength(action.replacement) - (action.end - action.start);
    }
    const start = decision.start + delta;
    allowed.add(`${decision.entityType}:${String(start)}:${String(start + decision.end - decision.start)}`);
  }
  return allowed;
}

function validateApplicationBinding(request: IndependentDocxVerificationRequest): void {
  const binding = request.applicationBinding;
  if (
    !validDigest(binding.capabilityDigest) || binding.capabilityDigest !== request.plan.capabilityDigest
    || !validComponent(binding.writer) || !validComponent(binding.application)
    || binding.writer.id !== request.plan.writer.id || binding.writer.version !== request.plan.writer.version
    || !componentIdPattern.test(binding.policy.id) || !versionPattern.test(binding.policy.version)
    || !validDigest(binding.policy.digest) || !['LOW', 'MODERATE', 'HIGH'].includes(binding.policy.riskTier)
    || binding.policy.id !== request.plan.policy.id || binding.policy.version !== request.plan.policy.version
    || binding.policy.digest !== request.plan.policy.digest || binding.policy.riskTier !== request.plan.policy.riskTier
    || (binding as unknown as { readonly outputMediaType?: unknown }).outputMediaType !== docxMediaType
    || !isRfc3339DateTime(binding.startedAt) || !isRfc3339DateTime(binding.completedAt)
    || Date.parse(binding.completedAt) < Date.parse(binding.startedAt)
  ) fail('BINDING_MISMATCH');
}

function computeSuppliedPlanSemanticsDigest(plan: IndependentDocxPlanBinding): Sha256Digest {
  const fields = [
    'local-pii:supplied-docx-plan-semantics:v1', plan.id, plan.digest, plan.inputDigest,
    plan.extractionRevision, plan.capabilityDigest, plan.policy.id, plan.policy.version, plan.policy.digest,
    plan.policy.riskTier, plan.writer.id, plan.writer.version, String(plan.expectedActionCount)
  ];
  for (const action of plan.actions) {
    fields.push(
      action.id, action.sourceSpanId ?? '', action.entityType, String(action.start), String(action.end), action.replacement
    );
  }
  if (plan.review === undefined) fields.push('NO_REVIEW');
  else {
    fields.push(
      'REVIEW', plan.review.extractionRevision, String(plan.review.revision), String(plan.review.decisionCount), plan.review.digest
    );
    for (const decision of plan.review.decisions) {
      fields.push(
        decision.sourceSpanId, decision.action, decision.entityType, decision.reviewedEntityType ?? '',
        String(decision.start), String(decision.end)
      );
    }
  }
  const hash = createHash('sha256');
  for (const field of fields) hash.update(String(Buffer.byteLength(field, 'utf8'))).update(':').update(field);
  return parseSha256Digest(`sha256:${hash.digest('hex')}`);
}

function computeSuppliedApplicationBindingDigest(
  request: IndependentDocxVerificationRequest,
  inputDigest: Sha256Digest,
  outputDigest: Sha256Digest,
  outputExtractionRevision: Sha256Digest
): Sha256Digest {
  const binding = request.applicationBinding;
  const fields = [
    'local-pii:docx-application-binding:v1', inputDigest, String(request.inputBytes.byteLength),
    outputDigest, String(request.outputBytes.byteLength), binding.outputMediaType, outputExtractionRevision,
    request.plan.id, request.plan.digest, computeSuppliedPlanSemanticsDigest(request.plan),
    binding.capabilityDigest, binding.policy.id, binding.policy.version,
    binding.policy.digest, binding.policy.riskTier, request.writerReceipt.receiptDigest,
    binding.writer.id, binding.writer.version, binding.writer.digest,
    binding.application.id, binding.application.version, binding.application.digest,
    binding.startedAt, binding.completedAt
  ];
  const hash = createHash('sha256');
  for (const field of fields) hash.update(String(Buffer.byteLength(field, 'utf8'))).update(':').update(field);
  return parseSha256Digest(`sha256:${hash.digest('hex')}`);
}

function validateBindings(request: IndependentDocxVerificationRequest, inputDigest: Sha256Digest, outputDigest: Sha256Digest): void {
  const { plan, writerReceipt: receipt } = request;
  if (
    !planIdPattern.test(plan.id) || !validDigest(plan.digest) || !validDigest(plan.extractionRevision)
    || !validDigest(plan.capabilityDigest) || plan.inputDigest !== inputDigest
    || plan.expectedActionCount !== plan.actions.length
    || plan.actions.length > maximumActions || new Set(plan.actions.map(({ id }) => id)).size !== plan.actions.length
    || plan.actions.some(({ id, entityType, start, end, replacement }, index) => {
      const previous = index === 0 ? undefined : plan.actions.at(index - 1);
      return !actionIdPattern.test(id) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end <= start || typeof replacement !== 'string' || !entityTypes.includes(entityType)
        || (index > 0 && (previous === undefined || start < previous.end));
    })
    || (receipt as unknown as { readonly schemaVersion?: unknown }).schemaVersion !== '1.0.0'
    || receipt.planDigest !== plan.digest || receipt.stagedDigest !== outputDigest
    || !validDigest(receipt.planDigest) || !validDigest(receipt.stagedDigest) || !validDigest(receipt.receiptDigest)
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
  validateReviewBinding(plan, unicodeCodePointLength(request.sourceCanonicalText));
  validateApplicationBinding(request);
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
  counts: Partial<Pick<IndependentDocxVerificationFoundation, 'inputEntryCount' | 'outputEntryCount' | 'retainedRegionCount' | 'classifiedRegionCount' | 'genericCarrierCount' | 'expectedActionCount' | 'appliedActionCount' | 'reviewedResidualCount'>> = {},
  applicationBindingDigest?: Sha256Digest
): IndependentDocxVerificationFoundation {
  return Object.freeze({
    outcome,
    checks: Object.freeze([
      'INDEPENDENT_ZIP_INVENTORY', 'INDEPENDENT_CONTENT_TYPE_GRAPH', 'INDEPENDENT_RELATIONSHIP_GRAPH',
      'INDEPENDENT_SOURCE_CARRIER_CLASSIFICATION', 'INDEPENDENT_EXTRACTION_REVISION',
      'GENERIC_XML_CARRIER_ENUMERATION', 'SUPPLIED_NATIVE_REGION_RECONCILIATION',
      'ACTION_RECEIPT_RECONCILIATION', 'INDEPENDENT_RESIDUAL_SCAN'
    ] as const),
    findings: Object.freeze(findings),
    inputEntryCount: counts.inputEntryCount ?? 0,
    outputEntryCount: counts.outputEntryCount ?? 0,
    retainedRegionCount: counts.retainedRegionCount ?? 0,
    classifiedRegionCount: counts.classifiedRegionCount ?? 0,
    genericCarrierCount: counts.genericCarrierCount ?? 0,
    expectedActionCount: counts.expectedActionCount ?? 0,
    appliedActionCount: counts.appliedActionCount ?? 0,
    reviewedResidualCount: counts.reviewedResidualCount ?? 0,
    suppliedApplicationInputsBound: applicationBindingDigest !== undefined,
    ...(applicationBindingDigest === undefined ? {} : { suppliedApplicationBindingDigest: applicationBindingDigest }),
    independentParser: true,
    fidelityVerified: false,
    authorizesPublication: false
  });
}

/**
 * Independently parses and reconciles a strict DOCX input/output pair without
 * importing or invoking the DOCX adapter. This is a non-authorizing foundation:
 * it binds a privacy-safe digest of supplied inputs relevant to a future
 * application attestation, but does not independently prove the compiled plan
 * identity or emit that attestation. Renderer fidelity, sandboxing, and
 * malicious-corpus qualification remain mandatory before publication can be enabled.
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
    const classified = classifySource(input);
    validateClassification(request, classified);
    const detailedCounts = {
      ...counts, inputEntryCount: input.entries.length, outputEntryCount: output.entries.length,
      genericCarrierCount: output.carriers.length, classifiedRegionCount: classified.regions.length
    };
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
    const outputClassified = classifySource(output);
    if (
      outputClassified.regions.length !== classified.regions.length
      || classified.regions.some((region, index) => {
        const candidate = outputClassified.regions[index];
        return candidate === undefined || locationIdentity(candidate.location) !== locationIdentity(region.location);
      })
    ) fail('CARRIER_CLASSIFICATION_MISMATCH');
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
    const evidence = detectDeterministic(outputClassified.canonicalText, outputClassified.extractionRevision);
    const resolution = resolveEvidence(evidence, outputClassified.extractionRevision, unicodeCodePointLength(outputClassified.canonicalText));
    if (resolution.conflicts.length > 0) fail('VERIFIER_INCOMPLETE');
    const permittedResiduals = permittedReviewedResiduals(request.plan);
    const byEntity = new Map<EntityType, number>();
    let reviewedResidualCount = 0;
    for (const span of resolution.spans) {
      if (permittedResiduals.has(`${span.entityType}:${String(span.start)}:${String(span.end)}`)) {
        reviewedResidualCount += 1;
        continue;
      }
      byEntity.set(span.entityType, (byEntity.get(span.entityType) ?? 0) + 1);
    }
    const qualifiedCarrierIds = new Set(outputRegions.flatMap(({ carrierIds }) => carrierIds));
    const extraValues = output.carriers.filter(({ id }) => !qualifiedCarrierIds.has(id)).map(({ value }) => value);
    if (extraValues.length > 0) {
      const extraText = extraValues.join(boundary);
      const extraEvidence = detectDeterministic(extraText, outputClassified.extractionRevision);
      const extraResolution = resolveEvidence(extraEvidence, outputClassified.extractionRevision, unicodeCodePointLength(extraText));
      if (extraResolution.conflicts.length > 0) fail('VERIFIER_INCOMPLETE');
      for (const span of extraResolution.spans) byEntity.set(span.entityType, (byEntity.get(span.entityType) ?? 0) + 1);
    }
    for (const [entityType, count] of byEntity) findings.push({ code: 'RESIDUAL_ENTITY', count, entityType });
    const bindingDigest = computeSuppliedApplicationBindingDigest(request, inputDigest, outputDigest, outputClassified.extractionRevision);
    return report(
      findings.length === 0 ? 'RECONCILED_SUPPLIED_REGIONS' : 'FAIL',
      findings,
      { ...detailedCounts, reviewedResidualCount },
      bindingDigest
    );
  } catch (error: unknown) {
    const code = error instanceof VerificationFailure ? error.code : 'VERIFIER_INCOMPLETE';
    return report(code === 'RESIDUAL_SOURCE_CANARY' || code === 'RESIDUAL_ENTITY' ? 'FAIL' : 'INCOMPLETE', [{ code, count: 1 }], counts);
  }
}
