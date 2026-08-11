import { createHash } from 'node:crypto';
import { basename, extname, resolve } from 'node:path';

import {
  defaultTextArtifactFileSystem,
  type StagedTextArtifact,
  type TextArtifactFileSystem,
  type TextArtifactPublication
} from '@local-pii/adapter-text';
import { parseSha256Digest, SafeError, type Sha256Digest } from '@local-pii/domain';

export const pdfAdapterVersion = '0.1.0';
export const defaultMaximumPdfInputBytes = 8 * 1024 * 1024;
const maximumPdfObjects = 205;
const maximumPdfPages = 100;
const maximumCanonicalCodePoints = 1_000_000;
const maximumLiteralCodePoints = 4_096;
const pdfMediaType = 'application/pdf';
const pageBoundary = '\n\u0000PDF-PAGE\u0000\n';

export const pdfWriterDescriptor = Object.freeze({
  id: 'pdf-extract-adapter',
  version: pdfAdapterVersion,
  digest: parseSha256Digest('sha256:f54028ca23b25966ca4bdcd63704723bd9bcb62b497a391df6de37f51d8249a8')
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
    { id: 'flat-page-tree', status: 'SUPPORTED' },
    { id: 'visible-ascii-literal-text', status: 'SUPPORTED' },
    { id: 'page-and-operator-reading-order', status: 'SUPPORTED' },
    { id: 'bounded-position-validation', status: 'SUPPORTED' },
    { id: 'encrypted-and-incremental-pdf', status: 'BLOCKED' },
    { id: 'compressed-object-and-content-streams', status: 'BLOCKED' },
    { id: 'metadata-actions-forms-annotations-attachments', status: 'BLOCKED' },
    { id: 'images-layers-patterns-and-alternate-fonts', status: 'BLOCKED' },
    { id: 'unicode-complex-layout-and-native-box-map', status: 'BLOCKED' },
    { id: 'ocr-and-scanned-pages', status: 'BLOCKED' },
    { id: 'redaction-writing-and-verification', status: 'BLOCKED' },
    { id: 'symbolic-links', status: 'BLOCKED' },
    { id: 'sandboxed-worker-isolation', status: 'BLOCKED' }
  ],
  verificationProfiles: ['pdf-literal-extract-v1'],
  limits: { maximumInputBytes: defaultMaximumPdfInputBytes }
} as const;

/** Extraction-conformance evidence only; never authorizes PDF publication. */
export const pdfExtractionVerificationCapabilityDescriptor = {
  id: 'pdf-literal-extract-v1',
  version: pdfAdapterVersion,
  formats: ['pdf'],
  checks: ['CLASSIC_XREF', 'CLOSED_OBJECT_GRAPH', 'CLOSED_TEXT_OPERATOR_SET']
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
  readonly objects: readonly ParsedObject[];
}

function unsupportedReason(source: string): UnsupportedPdfReason {
  if (source.includes('/Encrypt')) return 'encrypted';
  if (source.includes('/Prev') || source.includes('/XRefStm')) return 'incremental_update';
  if (source.includes('/JavaScript') || source.includes('/JS') || source.includes('/Launch')
    || source.includes('/OpenAction') || source.includes('/AA') || source.includes('/URI')
    || source.includes('/GoTo')) return 'active_content';
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

function parseClassicXref(source: string): ParsedXref {
  const xrefMarker = '\nxref\n';
  const xrefIndex = source.lastIndexOf(xrefMarker);
  if (xrefIndex < 0) formatCorrupt();
  const xrefOffset = xrefIndex + 1;
  const tail = source.slice(xrefOffset);
  const match = /^xref\n0 ([1-9][0-9]*)\n((?:[0-9]{10} [0-9]{5} [fn] \n)+)trailer\n<< \/Size ([1-9][0-9]*) \/Root ([1-9][0-9]*) 0 R >>\nstartxref\n([0-9]+)\n%%EOF\n$/u.exec(tail);
  if (match === null) {
    if (source.includes('/Prev') || source.includes('/XRefStm')) unsupported('incremental_update');
    formatCorrupt();
  }
  const count = Number(match[1]);
  const size = Number(match[3]);
  const root = Number(match[4]);
  const declaredXrefOffset = Number(match[5]);
  if (!Number.isSafeInteger(count) || count < 2 || count > maximumPdfObjects + 1
    || size !== count || root >= count || declaredXrefOffset !== xrefOffset) formatCorrupt();
  const lines = match[2]?.split('\n').filter((line) => line.length > 0) ?? [];
  if (lines.length !== count || lines[0] !== '0000000000 65535 f ') formatCorrupt();

  const offsets: number[] = [];
  for (let number = 1; number < count; number += 1) {
    const entry = /^([0-9]{10}) 00000 n $/u.exec(lines[number] ?? '');
    if (entry === null) formatCorrupt();
    const offset = Number(entry[1]);
    if (!Number.isSafeInteger(offset) || offset < '%PDF-1.4\n'.length || offset >= xrefOffset
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
  if (source.slice('%PDF-1.4\n'.length, offsets[0]).length !== 0) formatCorrupt();
  return Object.freeze({ root, objects: Object.freeze(objects) });
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

function integer(value: string, minimum: number, maximum: number): number {
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value)) formatCorrupt();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) formatCorrupt();
  return parsed;
}

function extractContent(body: string, page: PageDefinition): string {
  const prefix = /^<< \/Length ([1-9][0-9]*) >>\nstream\n/u.exec(body);
  if (prefix === null || !body.endsWith('\nendstream\n')) unsupported();
  const content = body.slice(prefix[0].length, -'\nendstream\n'.length);
  if (content.length !== Number(prefix[1]) || content.length > 256 * 1024) formatCorrupt();
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
  return text.join('\n');
}

function parsePdfText(bytes: Uint8Array): { readonly text: string; readonly pageCount: number } {
  const source = Buffer.from(bytes).toString('latin1');
  if (!source.startsWith('%PDF-1.4\n') || !source.endsWith('%%EOF\n')) formatCorrupt();
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index);
    if (codeUnit !== 0x09 && codeUnit !== 0x0a && codeUnit !== 0x0d
      && (codeUnit < 0x20 || codeUnit > 0x7e)) unsupported('unsupported_encoding');
  }
  const parsed = parseClassicXref(source);
  const byNumber = new Map(parsed.objects.map((object) => [object.number, object.body]));
  const catalog = /^<< \/Type \/Catalog \/Pages ([1-9][0-9]*) 0 R >>\n$/u.exec(byNumber.get(parsed.root) ?? '');
  if (catalog === null) unsupported(unsupportedReason(source));
  const pagesNumber = Number(catalog[1]);
  const pages = /^<< \/Type \/Pages \/Kids \[((?:[1-9][0-9]* 0 R ?)+)\] \/Count ([1-9][0-9]*) >>\n$/u.exec(byNumber.get(pagesNumber) ?? '');
  if (pages === null) unsupported(unsupportedReason(source));
  const pageRefs = [...(pages[1]?.matchAll(/([1-9][0-9]*) 0 R/gu) ?? [])].map((match) => Number(match[1]));
  const pageCount = Number(pages[2]);
  if (pageCount !== pageRefs.length || pageCount < 1 || pageCount > maximumPdfPages
    || new Set(pageRefs).size !== pageRefs.length) formatCorrupt();

  const used = new Set<number>([parsed.root, pagesNumber]);
  const pageTexts: string[] = [];
  for (const pageNumber of pageRefs) {
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
    pageTexts.push(extractContent(contentBody, page));
    used.add(pageNumber);
    used.add(page.font);
    used.add(page.contents);
  }
  if (used.size !== parsed.objects.length || parsed.objects.some(({ number }) => !used.has(number))) {
    unsupported(unsupportedReason(source));
  }
  const text = pageTexts.join(pageBoundary);
  if (text.length > maximumCanonicalCodePoints) formatCorrupt();
  return Object.freeze({ text, pageCount });
}

export function probePdfBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 18
    && Buffer.from(bytes.subarray(0, 9)).toString('ascii') === '%PDF-1.4\n'
    && Buffer.from(bytes.subarray(bytes.length - 6)).toString('ascii') === '%%EOF\n';
}

export function extractPdfBytes(bytes: Uint8Array): Readonly<{ text: string; pageCount: number }> {
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
  const extracted = extractPdfBytes(source.bytes);
  const digest = digestBytes(source.bytes);
  const extractionRevision = parseSha256Digest(`sha256:${createHash('sha256')
    .update('pdf-literal-extract-v1\0').update(digest).update('\0').update(extracted.text).digest('hex')}`);
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
    pageCount: extracted.pageCount
  });
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
