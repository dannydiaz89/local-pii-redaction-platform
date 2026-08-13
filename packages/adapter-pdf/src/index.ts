import { createHash } from 'node:crypto';
import { basename, extname, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import {
  defaultTextArtifactFileSystem,
  type StagedTextArtifact,
  type TextArtifactFileSystem,
  type TextArtifactPublication
} from '@local-pii/adapter-text';
import {
  parseSha256Digest,
  SafeError,
  type CanonicalRegion,
  type PdfMetadataField,
  type PdfMetadataValueLocationV4,
  type PdfTextItemLocationV3,
  type Sha256Digest
} from '@local-pii/domain';

export const pdfAdapterVersion = '0.5.0';
export const defaultMaximumPdfInputBytes = 8 * 1024 * 1024;
const maximumPdfObjects = 205;
const maximumPdfPages = 100;
const maximumCanonicalCodePoints = 1_000_000;
const maximumLiteralCodePoints = 4_096;
const maximumContentStreamBytes = 256 * 1024;
const maximumFlateExpansionRatio = 64;
const pdfMediaType = 'application/pdf';
const pageBoundary = '\n\u0000PDF-PAGE\u0000\n';
const metadataBoundary = '\n\u0000PDF-METADATA\u0000\n';

export const pdfWriterDescriptor = Object.freeze({
  id: 'pdf-extract-adapter',
  version: pdfAdapterVersion,
  digest: parseSha256Digest('sha256:642f288e39639c2f2d4fabe58d956b8ac65275f3f3648d02973cf0886e0c41ae')
});

export const pdfAdapterCapabilityDescriptor = {
  id: 'pdf',
  adapter: pdfWriterDescriptor.id,
  version: pdfAdapterVersion,
  mediaTypes: [pdfMediaType],
  extensions: ['.pdf'],
  operations: ['PROBE', 'INSPECT'],
  assurance: 'EXTRACT_ONLY',
  features: [
    { id: 'classic-single-revision-xref', status: 'SUPPORTED' },
    { id: 'pdf-14-and-binary-pdf-17-headers', status: 'SUPPORTED' },
    { id: 'bounded-flate-content-stream', status: 'SUPPORTED' },
    { id: 'value-free-open-action-xyz-destination', status: 'SUPPORTED' },
    { id: 'typed-info-and-xmp-metadata-source-map', status: 'SUPPORTED' },
    { id: 'flat-page-tree', status: 'SUPPORTED' },
    { id: 'visible-ascii-literal-text', status: 'SUPPORTED' },
    { id: 'page-and-operator-reading-order', status: 'SUPPORTED' },
    { id: 'bounded-position-validation', status: 'SUPPORTED' },
    { id: 'typed-page-object-text-item-source-map', status: 'SUPPORTED' },
    { id: 'encrypted-and-incremental-pdf', status: 'BLOCKED' },
    { id: 'object-and-xref-streams', status: 'BLOCKED' },
    { id: 'document-ids-unsupported-xmp-and-executable-carriers', status: 'BLOCKED' },
    { id: 'images-layers-patterns-and-alternate-fonts', status: 'BLOCKED' },
    { id: 'unicode-complex-layout-and-native-box-map', status: 'BLOCKED' },
    { id: 'ocr-and-scanned-pages', status: 'BLOCKED' },
    { id: 'redaction-writing-and-verification', status: 'BLOCKED' },
    { id: 'symbolic-links', status: 'BLOCKED' },
    { id: 'sandboxed-worker-isolation', status: 'BLOCKED' }
  ],
  verificationProfiles: ['pdf-literal-extract-v5'],
  limits: { maximumInputBytes: defaultMaximumPdfInputBytes }
} as const;

/** Extraction-conformance evidence only; never authorizes PDF publication. */
export const pdfExtractionVerificationCapabilityDescriptor = {
  id: 'pdf-literal-extract-v5',
  version: pdfAdapterVersion,
  formats: ['pdf'],
  checks: [
    'CLASSIC_XREF',
    'CLOSED_OBJECT_GRAPH',
    'CLOSED_TEXT_OPERATOR_SET',
    'BOUNDED_FLATE_CONTENT',
    'VALUE_FREE_XYZ_DESTINATION',
    'COMPLETE_METADATA_SOURCE_MAP',
    'COMPLETE_TEXT_ITEM_SOURCE_MAP'
  ]
} as const;

export interface PdfArtifact {
  readonly reference: string;
  readonly path: string;
  readonly displayName: string;
  readonly mediaType: typeof pdfMediaType;
  readonly byteLength: number;
  readonly digest: Sha256Digest;
  readonly extractionRevision: Sha256Digest;
  readonly text: string;
  readonly hasUtf8Bom: false;
  readonly pageCount: number;
  readonly regions: readonly CanonicalRegion[];
}

type UnsupportedPdfReason =
  | 'active_content'
  | 'attachments'
  | 'encrypted'
  | 'forms_or_annotations'
  | 'incremental_update'
  | 'metadata'
  | 'unsupported_encoding'
  | 'unknown_feature';

function formatCorrupt(): never {
  throw new SafeError({
    code: 'FORMAT_CORRUPT',
    message: 'The PDF input is malformed or exceeds the supported document limits.',
    retryable: false,
    correlationId: 'cor_pdf_adapter'
  });
}

function unsupported(reason: UnsupportedPdfReason = 'unknown_feature'): never {
  throw new SafeError({
    code: 'FORMAT_UNSUPPORTED',
    message: 'The PDF input contains a feature outside this adapter’s declared safe text surface.',
    retryable: false,
    correlationId: 'cor_pdf_adapter',
    details: { reason }
  });
}

function storageUnavailable(): never {
  throw new SafeError({
    code: 'STORAGE_UNAVAILABLE',
    message: 'The PDF input could not be read safely.',
    retryable: true,
    correlationId: 'cor_pdf_adapter'
  });
}

function changedDuringRead(): never {
  throw new SafeError({
    code: 'JOB_CONFLICT',
    message: 'The PDF input changed while it was being processed.',
    retryable: true,
    correlationId: 'cor_pdf_adapter'
  });
}

function digestBytes(bytes: Uint8Array): Sha256Digest {
  return parseSha256Digest(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

function sameIdentity(
  left: Readonly<{ dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number }>,
  right: Readonly<{ dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number }>
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readPdfBytes(
  inputPath: string,
  maximumInputBytes: number,
  fileSystem: TextArtifactFileSystem
): Promise<{ readonly path: string; readonly bytes: Buffer }> {
  const path = resolve(inputPath);
  let observed;
  try {
    observed = await fileSystem.lstat(path);
  } catch {
    storageUnavailable();
  }
  if (observed.isSymbolicLink() || !observed.isFile()) unsupported();
  if (observed.size < 1 || observed.size > maximumInputBytes) formatCorrupt();

  let handle;
  try {
    handle = await fileSystem.openRead(path);
  } catch {
    storageUnavailable();
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(observed, opened)) changedDuringRead();
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead < 1) formatCorrupt();
      offset += result.bytesRead;
    }
    const afterHandle = await handle.stat();
    if (!sameIdentity(opened, afterHandle)) changedDuringRead();
    const afterPath = await fileSystem.lstat(path);
    if (!sameIdentity(opened, afterPath) || afterPath.isSymbolicLink()) changedDuringRead();
    return { path, bytes };
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    return storageUnavailable();
  } finally {
    try { await handle.close(); } catch { storageUnavailable(); }
  }
}

interface ParsedObject {
  readonly number: number;
  readonly body: string;
}

interface ParsedXref {
  readonly root: number;
  readonly info?: number;
  readonly objects: readonly ParsedObject[];
}

function unsupportedReason(source: string): UnsupportedPdfReason {
  if (source.includes('/Encrypt')) return 'encrypted';
  if (source.includes('/Prev') || source.includes('/XRefStm')) return 'incremental_update';
  const activeClassifyingSource = source.replace(
    /\/OpenAction ?\[[1-9][0-9]* 0 R \/XYZ null null 0\]/gu,
    '/Value-Free-XYZ-Destination'
  );
  if (activeClassifyingSource.includes('/JavaScript') || activeClassifyingSource.includes('/JS')
    || activeClassifyingSource.includes('/Launch') || activeClassifyingSource.includes('/OpenAction')
    || activeClassifyingSource.includes('/AA') || activeClassifyingSource.includes('/URI')
    || activeClassifyingSource.includes('/GoTo')) return 'active_content';
  if (source.includes('/EmbeddedFile') || source.includes('/Filespec') || source.includes('/EmbeddedFiles')
    || source.includes('/AF')) {
    return 'attachments';
  }
  if (source.includes('/AcroForm') || source.includes('/Annots') || source.includes('/XFA')
    || source.includes('/Widget')) return 'forms_or_annotations';
  if (source.includes('/Metadata') || source.includes('/Info') || source.includes('/PieceInfo')) return 'metadata';
  if (source.includes('/Encoding') && !source.includes('/Encoding /WinAnsiEncoding')) {
    return 'unsupported_encoding';
  }
  return 'unknown_feature';
}

function parseClassicXref(source: string, headerLength: number): ParsedXref {
  const xrefMarker = '\nxref\n';
  const xrefIndex = source.lastIndexOf(xrefMarker);
  if (xrefIndex < 0) formatCorrupt();
  const xrefOffset = xrefIndex + 1;
  const tail = source.slice(xrefOffset);
  const match = /^xref\n0 ([1-9][0-9]*)\n((?:[0-9]{10} [0-9]{5} [fn] \n)+)trailer\n<< \/Size ([1-9][0-9]*) \/Root ([1-9][0-9]*) 0 R(?: \/Info ([1-9][0-9]*) 0 R)? >>\nstartxref\n([0-9]+)\n%%EOF\n$/u.exec(tail);
  if (match === null) {
    if (source.includes('/Prev') || source.includes('/XRefStm')) unsupported('incremental_update');
    const reason = unsupportedReason(source);
    if (reason !== 'unknown_feature') unsupported(reason);
    formatCorrupt();
  }
  const count = Number(match[1]);
  const size = Number(match[3]);
  const root = Number(match[4]);
  const info = match[5] === undefined ? undefined : Number(match[5]);
  const declaredXrefOffset = Number(match[6]);
  if (!Number.isSafeInteger(count) || count < 2 || count > maximumPdfObjects + 1
    || size !== count || root >= count || info === root || (info !== undefined && info >= count)
    || declaredXrefOffset !== xrefOffset) formatCorrupt();
  const lines = match[2]?.split('\n').filter((line) => line.length > 0) ?? [];
  if (lines.length !== count || lines[0] !== '0000000000 65535 f ') formatCorrupt();

  const offsets: number[] = [];
  for (let number = 1; number < count; number += 1) {
    const entry = /^([0-9]{10}) 00000 n $/u.exec(lines[number] ?? '');
    if (entry === null) formatCorrupt();
    const offset = Number(entry[1]);
    if (!Number.isSafeInteger(offset) || offset < headerLength || offset >= xrefOffset
      || (offsets.at(-1) ?? 0) >= offset) formatCorrupt();
    offsets.push(offset);
  }
  const objects = offsets.map((offset, index): ParsedObject => {
    const number = index + 1;
    const end = offsets[index + 1] ?? xrefOffset;
    const raw = source.slice(offset, end);
    const prefix = `${String(number)} 0 obj\n`;
    if (!raw.startsWith(prefix) || !raw.endsWith('endobj\n')) formatCorrupt();
    return Object.freeze({ number, body: raw.slice(prefix.length, -'endobj\n'.length) });
  });
  if (source.slice(headerLength, offsets[0]).length !== 0) formatCorrupt();
  return Object.freeze({ root, ...(info === undefined ? {} : { info }), objects: Object.freeze(objects) });
}

interface PageDefinition {
  readonly parent: number;
  readonly width: number;
  readonly height: number;
  readonly font: number;
  readonly contents: number;
}

function decodeLiteral(value: string): string {
  if (value.length < 1 || value.length > maximumLiteralCodePoints * 2
    || !/^(?:[\x20-\x26\x2a-\x5b\x5d-\x7e]|\\[\\()])+$/u.test(value)) unsupported('unsupported_encoding');
  const decoded = value.replace(/\\([\\()])/gu, '$1');
  if (decoded.length < 1 || decoded.length > maximumLiteralCodePoints) formatCorrupt();
  return decoded;
}

interface ParsedMetadataValue {
  readonly value: string;
  readonly location: PdfMetadataValueLocationV4;
}

const infoFieldByKey: Readonly<Record<string, PdfMetadataField>> = Object.freeze({
  Title: 'TITLE', Author: 'AUTHOR', Subject: 'SUBJECT', Keywords: 'KEYWORDS', Creator: 'CREATOR',
  Producer: 'PRODUCER', CreationDate: 'CREATION_DATE', ModDate: 'MODIFICATION_DATE', Trapped: 'TRAPPED'
});

function assertMetadataText(value: string): string {
  const hasDisallowedControl = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x08 || codePoint === 0x0b || codePoint === 0x0c
      || (codePoint >= 0x0e && codePoint <= 0x1f) || codePoint === 0x7f;
  });
  if (value.length < 1 || Array.from(value).length > maximumLiteralCodePoints || hasDisallowedControl) {
    unsupported('unsupported_encoding');
  }
  return value;
}

function decodeInfoHex(encoded: string): string {
  if (encoded.length < 2 || encoded.length > maximumLiteralCodePoints * 4
    || encoded.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/u.test(encoded)) unsupported('unsupported_encoding');
  const bytes = Buffer.from(encoded, 'hex');
  try {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      if ((bytes.length - 2) % 2 !== 0) unsupported('unsupported_encoding');
      const codeUnits: number[] = [];
      for (let index = 2; index < bytes.length; index += 2) {
        codeUnits.push(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
      }
      const value = String.fromCharCode(...codeUnits);
      for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = value.charCodeAt(index + 1);
          if (next < 0xdc00 || next > 0xdfff) unsupported('unsupported_encoding');
          index += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) unsupported('unsupported_encoding');
      }
      return assertMetadataText(value);
    }
    if (bytes.some((value) => value < 0x20 || value > 0x7e)) unsupported('unsupported_encoding');
    return assertMetadataText(bytes.toString('ascii'));
  } finally {
    bytes.fill(0);
  }
}

function parseInfoMetadata(body: string, object: number): readonly ParsedMetadataValue[] {
  if (!body.startsWith('<< ') || !body.endsWith(' >>\n')) unsupported('metadata');
  const inner = body.slice(3, -4);
  const token = /\/(Title|Author|Subject|Keywords|Creator|Producer|CreationDate|ModDate|Trapped) (\((?:[\x20-\x26\x2a-\x5b\x5d-\x7e]|\\[\\()])+\)|<[0-9A-Fa-f]+>|\/(?:True|False|Unknown))(?: |$)/gy;
  const values: ParsedMetadataValue[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset < inner.length) {
    token.lastIndex = offset;
    const match = token.exec(inner);
    if (match === null || match.index !== offset) unsupported('metadata');
    const key = match[1] ?? '';
    if (seen.has(key)) unsupported('metadata');
    seen.add(key);
    const raw = match[2] ?? '';
    const value = raw.startsWith('(')
      ? decodeLiteral(raw.slice(1, -1))
      : raw.startsWith('<')
        ? decodeInfoHex(raw.slice(1, -1))
        : assertMetadataText(raw.slice(1));
    const field = infoFieldByKey[key];
    if (field === undefined) unsupported('metadata');
    values.push(Object.freeze({
      value,
      location: Object.freeze({
        schemaVersion: '4.0.0', kind: 'PDF_METADATA_VALUE', carrier: 'INFO',
        object, field, occurrence: 1
      })
    }));
    offset = token.lastIndex;
  }
  if (values.length < 1 || values.length > 16) unsupported('metadata');
  return Object.freeze(values);
}

const xmpTextFieldByElement: Readonly<Record<string, PdfMetadataField>> = Object.freeze({
  'dc:format': 'DC_FORMAT', 'dc:title': 'DC_TITLE', 'dc:creator': 'DC_CREATOR',
  'dc:description': 'DC_DESCRIPTION', 'dc:subject': 'DC_SUBJECT', 'dc:date': 'DC_DATE',
  'xmp:CreatorTool': 'XMP_CREATOR_TOOL', 'xmp:CreateDate': 'XMP_CREATE_DATE',
  'xmp:ModifyDate': 'XMP_MODIFY_DATE', 'xmp:MetadataDate': 'XMP_METADATA_DATE',
  'pdf:Producer': 'PDF_PRODUCER', 'pdf:Keywords': 'PDF_KEYWORDS', 'pdf:PDFVersion': 'PDF_VERSION'
});
const xmpContainerElements = new Set(['x:xmpmeta', 'rdf:RDF', 'rdf:Description', 'rdf:Alt', 'rdf:Seq', 'rdf:Bag']);
const xmpNamespaceValues: Readonly<Record<string, string>> = Object.freeze({
  'xmlns:x': 'adobe:ns:meta/',
  'xmlns:rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'xmlns:dc': 'http://purl.org/dc/elements/1.1/',
  'xmlns:xmp': 'http://ns.adobe.com/xap/1.0/',
  'xmlns:pdf': 'http://ns.adobe.com/pdf/1.3/'
});
const xmpNamespaceByPrefix: Readonly<Record<string, string>> = Object.freeze({
  x: xmpNamespaceValues['xmlns:x'] ?? '',
  rdf: xmpNamespaceValues['xmlns:rdf'] ?? '',
  dc: xmpNamespaceValues['xmlns:dc'] ?? '',
  xmp: xmpNamespaceValues['xmlns:xmp'] ?? '',
  pdf: xmpNamespaceValues['xmlns:pdf'] ?? ''
});

interface XmpStackEntry {
  readonly name: string;
  readonly field?: PdfMetadataField;
  readonly namespaces: ReadonlyMap<string, string>;
  childCount: number;
  textSeen: boolean;
}

function xmpPrefix(name: string): string {
  const separator = name.indexOf(':');
  if (separator < 1 || separator === name.length - 1) unsupported('metadata');
  return name.slice(0, separator);
}

function validateXmpParent(name: string, parent: XmpStackEntry | undefined): void {
  if (parent === undefined) {
    if (name !== 'x:xmpmeta') unsupported('metadata');
    return;
  }
  if (parent.name === 'x:xmpmeta') {
    if (name !== 'rdf:RDF') unsupported('metadata');
  } else if (parent.name === 'rdf:RDF') {
    if (name !== 'rdf:Description') unsupported('metadata');
  } else if (parent.name === 'rdf:Description') {
    if (xmpTextFieldByElement[name] === undefined) unsupported('metadata');
  } else if (xmpTextFieldByElement[parent.name] !== undefined) {
    if (!['rdf:Alt', 'rdf:Seq', 'rdf:Bag'].includes(name)) unsupported('metadata');
  } else if (['rdf:Alt', 'rdf:Seq', 'rdf:Bag'].includes(parent.name)) {
    if (name !== 'rdf:li') unsupported('metadata');
  } else unsupported('metadata');
}

function parseXmpMetadata(xmlBytes: Buffer, object: number): readonly ParsedMetadataValue[] {
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(xmlBytes); } catch { unsupported('unsupported_encoding'); }
  if (xml.length < 1 || xml.length > maximumContentStreamBytes || xml.includes('<!') || xml.includes('&')) unsupported('metadata');
  const tokens = xml.match(/<[^>]+>|[^<]+/gu);
  if (tokens === null || tokens.join('') !== xml || tokens.length > 4_000) unsupported('metadata');
  const stack: XmpStackEntry[] = [];
  const occurrences = new Map<PdfMetadataField, number>();
  const values: ParsedMetadataValue[] = [];
  let sawBegin = false;
  let sawEnd = false;
  let rootCount = 0;
  let rootClosed = false;
  for (const part of tokens) {
    if (part.startsWith('<?')) {
      if (/^<\?xpacket begin=(?:"\uFEFF"|'\uFEFF'|""|'') id=(?:"W5M0MpCehiHzreSzNTczkc9d"|'W5M0MpCehiHzreSzNTczkc9d')\?>$/u.test(part)) {
        if (sawBegin || sawEnd || rootCount > 0 || stack.length > 0) unsupported('metadata');
        sawBegin = true;
      } else if (/^<\?xpacket end=(?:"[rw]"|'[rw]')\?>$/u.test(part)) {
        if (!sawBegin || !rootClosed || stack.length > 0 || sawEnd) unsupported('metadata');
        sawEnd = true;
      } else unsupported('metadata');
      continue;
    }
    if (part.startsWith('</')) {
      const name = /^<\/([A-Za-z_][A-Za-z0-9_.:-]*)>$/u.exec(part)?.[1];
      const closed = stack.pop();
      if (name === undefined || closed?.name !== name || sawEnd) unsupported('metadata');
      if (closed.name === 'x:xmpmeta') {
        if (closed.childCount !== 1 || stack.length > 0) unsupported('metadata');
        rootClosed = true;
      } else if (closed.name === 'rdf:RDF') {
        if (closed.childCount !== 1 || closed.textSeen) unsupported('metadata');
      } else if (closed.name === 'rdf:Description'
        || ['rdf:Alt', 'rdf:Seq', 'rdf:Bag'].includes(closed.name)) {
        if (closed.childCount < 1 || closed.textSeen) unsupported('metadata');
      } else if (xmpTextFieldByElement[closed.name] !== undefined) {
        if ((closed.textSeen ? 1 : 0) + closed.childCount !== 1) unsupported('metadata');
      } else if (closed.name === 'rdf:li') {
        if (!closed.textSeen || closed.childCount > 0) unsupported('metadata');
      }
      continue;
    }
    if (part.startsWith('<')) {
      if (!sawBegin || sawEnd || rootClosed) unsupported('metadata');
      const start = /^<([A-Za-z_][A-Za-z0-9_.:-]*)([^>]*)>$/u.exec(part);
      if (start === null || start[2]?.endsWith('/') === true) unsupported('metadata');
      const name = start[1] ?? '';
      const directField = xmpTextFieldByElement[name];
      if (!xmpContainerElements.has(name) && directField === undefined && name !== 'rdf:li') unsupported('metadata');
      const parent = stack.at(-1);
      validateXmpParent(name, parent);
      if (parent === undefined) {
        rootCount += 1;
        if (rootCount !== 1) unsupported('metadata');
      } else {
        if (parent.textSeen) unsupported('metadata');
        parent.childCount += 1;
      }
      const attributes = start[2] ?? '';
      const attribute = / ([A-Za-z_][A-Za-z0-9_.:-]*)=("[^"]*"|'[^']*')/gy;
      const parsedAttributes: { readonly name: string; readonly value: string }[] = [];
      const seenAttributes = new Set<string>();
      let attributeOffset = 0;
      while (attributeOffset < attributes.length) {
        attribute.lastIndex = attributeOffset;
        const match = attribute.exec(attributes);
        if (match === null || match.index !== attributeOffset) unsupported('metadata');
        const attributeName = match[1] ?? '';
        const attributeValue = (match[2] ?? '').slice(1, -1);
        if (seenAttributes.has(attributeName) || attributeValue.includes('<')) unsupported('metadata');
        seenAttributes.add(attributeName);
        parsedAttributes.push({ name: attributeName, value: attributeValue });
        attributeOffset = attribute.lastIndex;
      }
      const namespaces = new Map(parent?.namespaces ?? []);
      for (const { name: attributeName, value: attributeValue } of parsedAttributes) {
        if (attributeName in xmpNamespaceValues) {
          if (xmpNamespaceValues[attributeName] !== attributeValue) unsupported('metadata');
          if (!['x:xmpmeta', 'rdf:RDF', 'rdf:Description'].includes(name)) unsupported('metadata');
          namespaces.set(attributeName.slice('xmlns:'.length), attributeValue);
        }
      }
      const prefix = xmpPrefix(name);
      if (namespaces.get(prefix) !== xmpNamespaceByPrefix[prefix]) unsupported('metadata');
      for (const { name: attributeName, value: attributeValue } of parsedAttributes) {
        if (attributeName in xmpNamespaceValues) continue;
        if (attributeName === 'rdf:about') {
          if (name !== 'rdf:Description' || namespaces.get('rdf') !== xmpNamespaceByPrefix.rdf
            || attributeValue !== '') unsupported('metadata');
        } else if (attributeName === 'xml:lang') {
          if (name !== 'rdf:li') unsupported('metadata');
          values.push(Object.freeze({
            value: assertMetadataText(attributeValue),
            location: Object.freeze({
              schemaVersion: '4.0.0', kind: 'PDF_METADATA_VALUE', carrier: 'XMP', object,
              field: 'XML_LANGUAGE', occurrence: (occurrences.get('XML_LANGUAGE') ?? 0) + 1
            })
          }));
          occurrences.set('XML_LANGUAGE', (occurrences.get('XML_LANGUAGE') ?? 0) + 1);
        } else unsupported('metadata');
      }
      if (name === 'x:xmpmeta' && !seenAttributes.has('xmlns:x')) unsupported('metadata');
      if (name === 'rdf:RDF' && !seenAttributes.has('xmlns:rdf')) unsupported('metadata');
      if (name === 'rdf:Description' && !seenAttributes.has('rdf:about')) unsupported('metadata');
      const inheritedField = name === 'rdf:li' || ['rdf:Alt', 'rdf:Seq', 'rdf:Bag'].includes(name)
        ? parent?.field
        : undefined;
      const effectiveField = directField ?? inheritedField;
      stack.push(effectiveField === undefined
        ? { name, namespaces, childCount: 0, textSeen: false }
        : { name, field: effectiveField, namespaces, childCount: 0, textSeen: false });
      if (stack.length > 32) formatCorrupt();
      continue;
    }
    if (part.trim().length === 0) continue;
    if (!sawBegin || sawEnd || rootClosed) unsupported('metadata');
    if (part !== part.trim()) unsupported('metadata');
    const current = stack.at(-1);
    if (current === undefined) unsupported('metadata');
    const field = current.field;
    if (field === undefined || current.textSeen || current.childCount > 0
      || (xmpTextFieldByElement[current.name] === undefined && current.name !== 'rdf:li')) unsupported('metadata');
    current.textSeen = true;
    const occurrence = (occurrences.get(field) ?? 0) + 1;
    occurrences.set(field, occurrence);
    values.push(Object.freeze({
      value: assertMetadataText(part),
      location: Object.freeze({
        schemaVersion: '4.0.0', kind: 'PDF_METADATA_VALUE', carrier: 'XMP', object, field, occurrence
      })
    }));
  }
  if (!sawBegin || !sawEnd || rootCount !== 1 || !rootClosed || stack.length > 0
    || values.length < 1 || values.length > 256) unsupported('metadata');
  return Object.freeze(values);
}

function extractXmpMetadata(body: string, object: number): readonly ParsedMetadataValue[] {
  const prefix = /^<< \/Type \/Metadata \/Subtype \/XML \/Length ([1-9][0-9]*) >>\nstream\n/u.exec(body);
  const suffix = '\nendstream\n';
  if (prefix === null || !body.endsWith(suffix)) unsupported('metadata');
  const payload = body.slice(prefix[0].length, -suffix.length);
  if (payload.length !== Number(prefix[1]) || payload.length > maximumContentStreamBytes) formatCorrupt();
  const bytes = Buffer.from(payload, 'latin1');
  try { return parseXmpMetadata(bytes, object); } finally { bytes.fill(0); }
}

function integer(value: string, minimum: number, maximum: number): number {
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value)) formatCorrupt();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) formatCorrupt();
  return parsed;
}

function parseContentCommands(content: string, page: PageDefinition): readonly string[] {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== 'BT' || lines.at(-1) !== 'ET' || lines.length < 5) unsupported();
  const font = /^\/F1 ([1-9][0-9]?) Tf$/u.exec(lines[1] ?? '');
  const origin = /^(-?[0-9]+) (-?[0-9]+) Td$/u.exec(lines[2] ?? '');
  if (font === null || origin === null) unsupported();
  const fontSize = integer(font[1] ?? '', 6, 72);
  let x = integer(origin[1] ?? '', 0, page.width);
  let y = integer(origin[2] ?? '', 0, page.height);
  const text: string[] = [];
  let expectText = true;
  for (const line of lines.slice(3, -1)) {
    if (expectText) {
      const shown = /^\(((?:[\x20-\x26\x2a-\x5b\x5d-\x7e]|\\[\\()])+)\) Tj$/u.exec(line);
      if (shown === null) unsupported();
      const decoded = decodeLiteral(shown[1] ?? '');
      // 1.1 em exceeds the widest accepted built-in Helvetica ASCII glyph.
      const estimatedWidth = decoded.length * fontSize * 1.1;
      if (x < 0 || y - fontSize < 0 || y + fontSize > page.height
        || x + estimatedWidth > page.width) unsupported();
      text.push(decoded);
    } else {
      const move = /^(-?[0-9]+) (-?[0-9]+) Td$/u.exec(line);
      if (move === null) unsupported();
      x += integer(move[1] ?? '', -page.width, page.width);
      y += integer(move[2] ?? '', -page.height, page.height);
    }
    expectText = !expectText;
  }
  if (expectText || text.length < 1) unsupported();
  return Object.freeze(text);
}

function extractContent(body: string, page: PageDefinition): readonly string[] {
  const plainPrefix = /^<< \/Length ([1-9][0-9]*) >>\nstream\n/u.exec(body);
  const flatePrefix = /^<< \/Length ([1-9][0-9]*) \/Filter \/FlateDecode >>\nstream\n/u.exec(body);
  const prefix = plainPrefix ?? flatePrefix;
  const suffix = '\nendstream\n';
  if (prefix === null || !body.endsWith(suffix)) unsupported();
  const payload = body.slice(prefix[0].length, -suffix.length);
  const declaredLength = Number(prefix[1]);
  if (!Number.isSafeInteger(declaredLength) || payload.length !== declaredLength
    || payload.length > maximumContentStreamBytes) formatCorrupt();
  if (flatePrefix === null) return parseContentCommands(payload, page);

  const encoded = Buffer.from(payload, 'latin1');
  const expansionLimit = Math.min(
    maximumContentStreamBytes,
    Math.max(1_024, encoded.byteLength * maximumFlateExpansionRatio)
  );
  let decoded: Buffer | undefined;
  try {
    // The pinned Node runtime returns this documented shape for `info: true`; its ambient type
    // currently exposes only the legacy Buffer overload.
    const result = inflateSync(encoded, { info: true, maxOutputLength: expansionLimit }) as unknown as {
      readonly buffer: Buffer;
      readonly engine: Readonly<{ bytesWritten: number }>;
    };
    if (result.engine.bytesWritten !== encoded.byteLength) formatCorrupt();
    const inflatedBuffer = result.buffer;
    decoded = inflatedBuffer;
    if (inflatedBuffer.byteLength < 1 || inflatedBuffer.byteLength > expansionLimit) formatCorrupt();
    return parseContentCommands(inflatedBuffer.toString('latin1'), page);
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    return formatCorrupt();
  } finally {
    encoded.fill(0);
    decoded?.fill(0);
  }
}

function pdfHeaderLength(source: string): number {
  if (source.startsWith('%PDF-1.4\n')) return '%PDF-1.4\n'.length;
  const binary17 = /^%PDF-1\.7\n%[\x80-\xff]{4,16}\n/u.exec(source);
  if (binary17 !== null) return binary17[0].length;
  formatCorrupt();
}

function parsePdfText(bytes: Uint8Array): {
  readonly text: string;
  readonly pageCount: number;
  readonly regions: readonly CanonicalRegion[];
} {
  const source = Buffer.from(bytes).toString('latin1');
  if (!source.endsWith('%%EOF\n')) formatCorrupt();
  const headerLength = pdfHeaderLength(source);
  const parsed = parseClassicXref(source, headerLength);
  const byNumber = new Map(parsed.objects.map((object) => [object.number, object.body]));
  const catalogBody = byNumber.get(parsed.root) ?? '';
  const catalog = /^<< \/Type \/Catalog \/Pages ([1-9][0-9]*) 0 R(?: \/Metadata ([1-9][0-9]*) 0 R)?(?: \/OpenAction ?\[([1-9][0-9]*) 0 R \/XYZ null null 0\])? >>\n$/u.exec(catalogBody);
  if (catalog === null) unsupported(unsupportedReason(source));
  const pagesNumber = Number(catalog[1]);
  const metadataObject = catalog[2] === undefined ? undefined : Number(catalog[2]);
  const openActionPage = catalog[3] === undefined ? undefined : Number(catalog[3]);
  const pages = /^<< \/Type \/Pages \/Kids \[((?:[1-9][0-9]* 0 R ?)+)\] \/Count ([1-9][0-9]*) >>\n$/u.exec(byNumber.get(pagesNumber) ?? '');
  if (pages === null) unsupported(unsupportedReason(source));
  const pageRefs = [...(pages[1]?.matchAll(/([1-9][0-9]*) 0 R/gu) ?? [])].map((match) => Number(match[1]));
  const pageCount = Number(pages[2]);
  if (pageCount !== pageRefs.length || pageCount < 1 || pageCount > maximumPdfPages
    || new Set(pageRefs).size !== pageRefs.length) formatCorrupt();
  if (openActionPage !== undefined && !pageRefs.includes(openActionPage)) formatCorrupt();

  const used = new Set<number>([parsed.root, pagesNumber]);
  const pageTexts: string[] = [];
  const regions: CanonicalRegion[] = [];
  let canonicalOffset = 0;
  for (const [pageIndex, pageNumber] of pageRefs.entries()) {
    const match = /^<< \/Type \/Page \/Parent ([1-9][0-9]*) 0 R \/MediaBox \[0 0 ([1-9][0-9]*) ([1-9][0-9]*)\] \/Resources << \/Font << \/F1 ([1-9][0-9]*) 0 R >> >> \/Contents ([1-9][0-9]*) 0 R >>\n$/u.exec(byNumber.get(pageNumber) ?? '');
    if (match === null) unsupported(unsupportedReason(source));
    const page: PageDefinition = {
      parent: Number(match[1]),
      width: integer(match[2] ?? '', 100, 2_000),
      height: integer(match[3] ?? '', 100, 2_000),
      font: Number(match[4]),
      contents: Number(match[5])
    };
    if (page.parent !== pagesNumber || page.font === page.contents) formatCorrupt();
    const fontBody = byNumber.get(page.font);
    if (fontBody !== '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n') {
      unsupported('unsupported_encoding');
    }
    const contentBody = byNumber.get(page.contents);
    if (contentBody === undefined) formatCorrupt();
    const textItems = extractContent(contentBody, page);
    const pageText = textItems.join('\n');
    for (const [textItemIndex, item] of textItems.entries()) {
      const location: PdfTextItemLocationV3 = Object.freeze({
        schemaVersion: '3.0.0',
        kind: 'PDF_TEXT_ITEM',
        page: pageIndex + 1,
        pageObject: pageNumber,
        contentObject: page.contents,
        fontObject: page.font,
        textItem: textItemIndex + 1,
        glyphCount: item.length
      });
      regions.push(Object.freeze({
        schemaVersion: '3.0.0',
        start: canonicalOffset,
        end: canonicalOffset + item.length,
        offsetUnit: 'UNICODE_CODE_POINT',
        role: 'VALUE',
        location
      }));
      canonicalOffset += item.length;
      if (textItemIndex < textItems.length - 1) canonicalOffset += 1;
    }
    pageTexts.push(pageText);
    if (pageIndex < pageRefs.length - 1) canonicalOffset += pageBoundary.length;
    if (canonicalOffset > maximumCanonicalCodePoints) formatCorrupt();
    used.add(pageNumber);
    used.add(page.font);
    used.add(page.contents);
  }
  const metadataValues: ParsedMetadataValue[] = [];
  if (parsed.info !== undefined) {
    const infoBody = byNumber.get(parsed.info);
    if (infoBody === undefined) formatCorrupt();
    metadataValues.push(...parseInfoMetadata(infoBody, parsed.info));
    used.add(parsed.info);
  }
  if (metadataObject !== undefined) {
    const metadataBody = byNumber.get(metadataObject);
    if (metadataBody === undefined) formatCorrupt();
    metadataValues.push(...extractXmpMetadata(metadataBody, metadataObject));
    used.add(metadataObject);
  }
  if ((parsed.info === undefined) !== (metadataObject === undefined)) unsupported('metadata');

  const pageText = pageTexts.join(pageBoundary);
  const metadataText = metadataValues.map(({ value }) => value).join('\n');
  if (metadataValues.length > 0) {
    canonicalOffset += metadataBoundary.length;
    for (const [index, item] of metadataValues.entries()) {
      const length = Array.from(item.value).length;
      regions.push(Object.freeze({
        schemaVersion: '4.0.0', start: canonicalOffset, end: canonicalOffset + length,
        offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE', location: item.location
      }));
      canonicalOffset += length;
      if (index < metadataValues.length - 1) canonicalOffset += 1;
    }
  }
  if (used.size !== parsed.objects.length || parsed.objects.some(({ number }) => !used.has(number))) {
    unsupported(unsupportedReason(source));
  }
  const text = metadataValues.length === 0 ? pageText : `${pageText}${metadataBoundary}${metadataText}`;
  const textLength = Array.from(text).length;
  if (textLength > maximumCanonicalCodePoints) formatCorrupt();
  if (regions.length < 1 || canonicalOffset !== textLength
    || regions.some((region) => region.end > textLength)) formatCorrupt();
  return Object.freeze({ text, pageCount, regions: Object.freeze(regions) });
}

export function probePdfBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 18
    || Buffer.from(bytes.subarray(bytes.length - 6)).toString('ascii') !== '%%EOF\n') return false;
  const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 32))).toString('latin1');
  return prefix.startsWith('%PDF-1.4\n') || /^%PDF-1\.7\n%[\x80-\xff]{4,16}\n/u.test(prefix);
}

export function extractPdfBytes(bytes: Uint8Array): Readonly<{
  text: string;
  pageCount: number;
  regions: readonly CanonicalRegion[];
}> {
  if (bytes.length < 1 || bytes.length > defaultMaximumPdfInputBytes) formatCorrupt();
  return parsePdfText(bytes);
}

export async function readPdfArtifact(
  inputPath: string,
  maximumInputBytes = defaultMaximumPdfInputBytes,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
): Promise<PdfArtifact> {
  if (!Number.isSafeInteger(maximumInputBytes) || maximumInputBytes < 1
    || maximumInputBytes > defaultMaximumPdfInputBytes) {
    throw new TypeError('Maximum PDF input bytes must be within the adapter limit.');
  }
  if (extname(inputPath).toLowerCase() !== '.pdf') unsupported();
  const source = await readPdfBytes(inputPath, maximumInputBytes, fileSystem);
  try {
    const extracted = extractPdfBytes(source.bytes);
    const digest = digestBytes(source.bytes);
    const extractionRevision = parseSha256Digest(`sha256:${createHash('sha256')
      .update('pdf-literal-extract-v5\0').update(digest).update('\0').update(extracted.text).digest('hex')}`);
    return Object.freeze({
      reference: source.path,
      path: source.path,
      displayName: basename(source.path),
      mediaType: pdfMediaType,
      byteLength: source.bytes.byteLength,
      digest,
      extractionRevision,
      text: extracted.text,
      hasUtf8Bom: false,
      pageCount: extracted.pageCount,
      regions: extracted.regions
    });
  } finally {
    source.bytes.fill(0);
  }
}

function redactionUnsupportedError(): SafeError {
  return new SafeError({
    code: 'FORMAT_UNSUPPORTED',
    message: 'PDF redaction and verification are not available for this extraction-only profile.',
    retryable: false,
    correlationId: 'cor_pdf_adapter',
    details: { reason: 'unknown_feature' }
  });
}

export function createLocalPdfArtifactSession(
  inputPath: string,
  maximumInputBytes = defaultMaximumPdfInputBytes,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
) {
  let sourcePromise: Promise<PdfArtifact> | undefined;
  return {
    writer: pdfWriterDescriptor,
    async input(signal?: AbortSignal): Promise<PdfArtifact> {
      signal?.throwIfAborted();
      sourcePromise ??= readPdfArtifact(inputPath, maximumInputBytes, fileSystem);
      const source = await sourcePromise;
      signal?.throwIfAborted();
      return source;
    },
    stage(plan: unknown, signal?: AbortSignal): Promise<StagedTextArtifact> {
      void plan;
      void signal;
      return Promise.reject(redactionUnsupportedError());
    },
    reopen(staged: StagedTextArtifact, signal?: AbortSignal): Promise<PdfArtifact> {
      void staged;
      void signal;
      return Promise.reject(redactionUnsupportedError());
    },
    publish(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifactPublication> {
      void staged;
      void signal;
      return Promise.reject(redactionUnsupportedError());
    },
    discard(staged: StagedTextArtifact, signal?: AbortSignal): Promise<void> {
      void staged;
      void signal;
      return Promise.reject(redactionUnsupportedError());
    }
  };
}
