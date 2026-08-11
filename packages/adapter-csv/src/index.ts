import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';

import {
  defaultTextArtifactFileSystem,
  deriveRedactedOutputPath,
  discardStagedTextArtifact,
  publishStagedTextArtifact,
  readLocalUtf8Artifact,
  stageTextArtifact,
  type LocalUtf8Artifact,
  type StagedTextArtifact,
  type TextArtifactFileSystem,
  type TextArtifactPublication
} from '@local-pii/adapter-text';
import { computeWriterReceiptDigest, type RedactionWriterReceiptContract } from '@local-pii/contracts';
import { SafeError, parseSha256Digest, unicodeCodePointLength, type CanonicalRegionV1, type Sha256Digest } from '@local-pii/domain';
import { assertTypedLabelPlanIntegrity, type TypedLabelAction, type TypedLabelPlan } from '@local-pii/redaction';

export const csvAdapterVersion = '0.1.0';
export const defaultMaximumCsvInputBytes = 100 * 1024 * 1024;
export const csvWriterDescriptor = Object.freeze({
  id: 'csv-adapter',
  version: csvAdapterVersion,
  digest: parseSha256Digest('sha256:2fdba7b1085bf828e174c912e69766c3af12855607c9de2086ac3dd41c2e9011')
});
export const csvAdapterCapabilityDescriptor = {
  id: 'csv',
  adapter: csvWriterDescriptor.id,
  version: csvAdapterVersion,
  mediaTypes: ['text/csv'],
  extensions: ['.csv'],
  operations: ['PROBE', 'INSPECT', 'EXTRACT', 'SCAN', 'REDACT', 'VERIFY'],
  assurance: 'NATIVE_REDACTION',
  features: [
    { id: 'utf-8', status: 'SUPPORTED' },
    { id: 'cell-only-transformation', status: 'SUPPORTED' },
    { id: 'comma-tab-semicolon-detection', status: 'SUPPORTED' },
    { id: 'double-quote-escaping', status: 'SUPPORTED' },
    { id: 'byte-preserving-untouched-tokens', status: 'SUPPORTED' },
    { id: 'uniform-row-width', status: 'SUPPORTED' },
    { id: 'explicit-delimiter-selection', status: 'SUPPORTED' },
    { id: 'explicit-header-exclusion', status: 'SUPPORTED' },
    { id: 'exact-column-policy', status: 'SUPPORTED' },
    { id: 'spreadsheet-formula-semantics', status: 'BLOCKED' },
    { id: 'streaming', status: 'BLOCKED' },
    { id: 'symbolic-links', status: 'BLOCKED' }
  ],
  verificationProfiles: ['text-rescan-v1'],
  limits: { maximumInputBytes: defaultMaximumCsvInputBytes }
} as const;

type CsvDelimiter = ',' | '\t' | ';';
export type CsvDelimiterSelection = 'AUTO' | 'COMMA' | 'TAB' | 'SEMICOLON';
export type CsvHeaderMode = 'NONE' | 'PRESENT';
export interface CsvExtractionOptions {
  readonly delimiter: CsvDelimiterSelection;
  readonly header: CsvHeaderMode;
}
export const defaultCsvExtractionOptions: CsvExtractionOptions = Object.freeze({
  delimiter: 'AUTO',
  header: 'NONE'
});
const supportedDelimiterSelections: ReadonlySet<unknown> = new Set(['AUTO', 'COMMA', 'TAB', 'SEMICOLON']);
const supportedHeaderModes: ReadonlySet<unknown> = new Set(['NONE', 'PRESENT']);

function validatedExtractionOptions(value: unknown): CsvExtractionOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('CSV extraction options are invalid.');
  }
  const options = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(options).length !== 2
    || !supportedDelimiterSelections.has(options.delimiter)
    || !supportedHeaderModes.has(options.header)
  ) throw new TypeError('CSV extraction options are invalid.');
  return Object.freeze({
    delimiter: options.delimiter as CsvDelimiterSelection,
    header: options.header as CsvHeaderMode
  });
}
type WriterReceipt = RedactionWriterReceiptContract.WriterReceipt;

interface CsvCellRegion {
  readonly row: number;
  readonly column: number;
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly value: string;
  readonly quoted: boolean;
}

export interface CsvArtifact extends LocalUtf8Artifact {
  readonly mediaType: 'text/csv';
  readonly extractionRevision: Sha256Digest;
  readonly canonicalText: string;
  readonly text: string;
  readonly regions: readonly CanonicalRegionV1[];
}

interface CsvArtifactState {
  readonly delimiter: CsvDelimiter;
  readonly regions: readonly CsvCellRegion[];
  readonly rawText: string;
}

interface ParsedCsv {
  readonly delimiter: CsvDelimiter;
  readonly delimiterCount: number;
  readonly columnCount: number;
  readonly canonicalText: string;
  readonly regions: readonly CsvCellRegion[];
  readonly headerValues: readonly string[];
  readonly extractionRevision: Sha256Digest;
}

const csvArtifactStates = new WeakMap<CsvArtifact, CsvArtifactState>();
const csvBoundary = '\n\u0000\n';
const supportedDelimiters: readonly CsvDelimiter[] = [',', '\t', ';'];
const maximumCsvRows = 100_000;
const maximumCsvColumns = 1_000;
const maximumCsvCells = 100_000;
const maximumCanonicalCodePoints = 10_000_000;
const maximumPlanActions = 100_000;
const actionIdPattern = /^act_[0-9A-HJKMNP-TV-Z]{26}$/u;

function formatCorrupt(): never {
  throw new SafeError({
    code: 'FORMAT_CORRUPT',
    message: 'The CSV input is malformed, ambiguous, or exceeds the supported structural limits.',
    retryable: false,
    correlationId: 'cor_csv_adapter'
  });
}

function parseWithDelimiter(source: string, delimiter: CsvDelimiter, header: CsvHeaderMode): ParsedCsv {
  const preliminary: Array<Omit<CsvCellRegion, 'canonicalStart' | 'canonicalEnd'>> = [];
  let index = 0;
  let row = 0;
  let column = 0;
  let expectedColumns: number | undefined;
  let delimiterCount = 0;

  const finishRow = (): void => {
    const width = column + 1;
    if (width > maximumCsvColumns) formatCorrupt();
    expectedColumns ??= width;
    if (expectedColumns !== width) formatCorrupt();
    row += 1;
    if (row > maximumCsvRows) formatCorrupt();
    column = 0;
  };

  for (;;) {
    if (preliminary.length >= maximumCsvCells) formatCorrupt();
    const rawStart = index;
    let value = '';
    let quoted = false;
    if (source[index] === '"') {
      quoted = true;
      index += 1;
      const parts: string[] = [];
      let valueStart = index;
      let closed = false;
      while (index < source.length) {
        if (source[index] !== '"') {
          index += 1;
          continue;
        }
        parts.push(source.slice(valueStart, index));
        if (source[index + 1] === '"') {
          parts.push('"');
          index += 2;
          valueStart = index;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      if (!closed) formatCorrupt();
      value = parts.join('');
      const follower = source[index];
      if (follower !== undefined && follower !== delimiter && follower !== '\r' && follower !== '\n') formatCorrupt();
    } else {
      const valueStart = index;
      while (index < source.length && source[index] !== delimiter && source[index] !== '\r' && source[index] !== '\n') {
        if (source[index] === '"') formatCorrupt();
        index += 1;
      }
      value = source.slice(valueStart, index);
    }
    preliminary.push({ row, column, rawStart, rawEnd: index, value, quoted });

    if (source[index] === delimiter) {
      delimiterCount += 1;
      column += 1;
      index += 1;
      continue;
    }
    if (source[index] === '\r' || source[index] === '\n') {
      finishRow();
      if (source[index] === '\r' && source[index + 1] === '\n') index += 2;
      else index += 1;
      if (index === source.length) break;
      continue;
    }
    if (index === source.length) {
      finishRow();
      break;
    }
    formatCorrupt();
  }

  const headerValues = header === 'PRESENT'
    ? preliminary.filter(({ row }) => row === 0).map(({ value }) => value)
    : [];
  if (header === 'PRESENT' && new Set(headerValues).size !== headerValues.length) formatCorrupt();
  const included = header === 'PRESENT' ? preliminary.filter(({ row }) => row > 0) : preliminary;
  let canonicalLength = 0;
  const canonicalParts: string[] = [];
  const regions: CsvCellRegion[] = [];
  const hash = createHash('sha256')
    .update('local-pii:csv-extraction:v2\u0000', 'utf8')
    .update(delimiter, 'utf8')
    .update('\u0000', 'utf8')
    .update(header, 'utf8');
  for (const cell of preliminary) {
    hash
      .update(`C:${String(cell.row)}:${String(cell.column)}:`, 'utf8')
      .update(String(Buffer.byteLength(cell.value, 'utf8')), 'utf8')
      .update(':', 'utf8')
      .update(cell.value, 'utf8');
  }
  for (const cell of included) {
    if (regions.length > 0) {
      canonicalParts.push(csvBoundary);
      canonicalLength += unicodeCodePointLength(csvBoundary);
    }
    const canonicalStart = canonicalLength;
    canonicalLength += unicodeCodePointLength(cell.value);
    if (canonicalLength > maximumCanonicalCodePoints) formatCorrupt();
    canonicalParts.push(cell.value);
    const region = { ...cell, canonicalStart, canonicalEnd: canonicalLength };
    regions.push(region);
  }
  return {
    delimiter,
    delimiterCount,
    columnCount: expectedColumns ?? 1,
    canonicalText: canonicalParts.join(''),
    regions: Object.freeze(regions.map((region) => Object.freeze(region))),
    headerValues: Object.freeze([...headerValues]),
    extractionRevision: parseSha256Digest(`sha256:${hash.digest('hex')}`)
  };
}

function selectedDelimiter(selection: Exclude<CsvDelimiterSelection, 'AUTO'>): CsvDelimiter {
  if (selection === 'COMMA') return ',';
  if (selection === 'TAB') return '\t';
  return ';';
}

function parseCsv(source: string, options: CsvExtractionOptions): ParsedCsv {
  if (options.delimiter !== 'AUTO') return parseWithDelimiter(source, selectedDelimiter(options.delimiter), options.header);
  let commaFallback: ParsedCsv | undefined;
  let evidenced: ParsedCsv | undefined;
  let ambiguous = false;
  for (const delimiter of supportedDelimiters) {
    try {
      const candidate = parseWithDelimiter(source, delimiter, options.header);
      if (candidate.delimiterCount > 0 && candidate.columnCount > 1) {
        if (evidenced !== undefined) {
          ambiguous = true;
          break;
        }
        evidenced = candidate;
      } else if (delimiter === ',' && candidate.columnCount === 1) {
        commaFallback = candidate;
      }
    } catch (error: unknown) {
      if (!(error instanceof SafeError) || error.code !== 'FORMAT_CORRUPT') throw error;
    }
  }
  if (ambiguous) return formatCorrupt();
  if (evidenced !== undefined) return evidenced;
  if (commaFallback !== undefined) return commaFallback;
  return formatCorrupt();
}

export async function readCsvArtifact(
  inputPath: string,
  maximumBytes = defaultMaximumCsvInputBytes,
  options: CsvExtractionOptions = defaultCsvExtractionOptions,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
): Promise<CsvArtifact> {
  const selectedOptions = validatedExtractionOptions(options);
  if (extname(inputPath).toLowerCase() !== '.csv') {
    throw new SafeError({ code: 'FORMAT_UNSUPPORTED', message: 'This adapter supports CSV files only.', retryable: false, correlationId: 'cor_csv_adapter' });
  }
  const source = await readLocalUtf8Artifact(inputPath, maximumBytes, fileSystem);
  const parsed = parseCsv(source.text, selectedOptions);
  const regions = Object.freeze(parsed.regions.map((region): CanonicalRegionV1 => {
    const headerValue = parsed.headerValues[region.column];
    return Object.freeze({
      schemaVersion: '1.0.0',
      start: region.canonicalStart,
      end: region.canonicalEnd,
      offsetUnit: 'UNICODE_CODE_POINT',
      role: 'VALUE',
      location: Object.freeze({
        schemaVersion: '1.0.0',
        kind: 'CSV_CELL',
        row: region.row + 1,
        column: region.column + 1
      }),
      ...(selectedOptions.header === 'PRESENT'
        && headerValue !== undefined
        && headerValue.length > 0
        && unicodeCodePointLength(headerValue) <= 256
        ? { selector: Object.freeze({ csvHeader: headerValue }) }
        : {})
    });
  }));
  const artifact: CsvArtifact = Object.freeze({
    ...source,
    mediaType: 'text/csv',
    extractionRevision: parsed.extractionRevision,
    canonicalText: parsed.canonicalText,
    text: parsed.canonicalText,
    regions
  });
  csvArtifactStates.set(artifact, { delimiter: parsed.delimiter, regions: parsed.regions, rawText: source.text });
  return artifact;
}

function transformValue(value: string, actions: readonly TypedLabelAction[], regionStart: number): string {
  let codePointCursor = 0;
  let utf16Cursor = 0;
  let unchangedStart = 0;
  const parts: string[] = [];
  const advanceTo = (target: number): void => {
    while (utf16Cursor < value.length && codePointCursor < target) {
      const code = value.codePointAt(utf16Cursor);
      utf16Cursor += code !== undefined && code > 0xffff ? 2 : 1;
      codePointCursor += 1;
    }
    if (codePointCursor !== target) formatCorrupt();
  };
  for (const action of actions) {
    advanceTo(action.start - regionStart);
    parts.push(value.slice(unchangedStart, utf16Cursor), action.replacement);
    advanceTo(action.end - regionStart);
    unchangedStart = utf16Cursor;
  }
  parts.push(value.slice(unchangedStart));
  return parts.join('');
}

function assertPlan(plan: TypedLabelPlan, source: CsvArtifact, regions: readonly CsvCellRegion[]): Map<CsvCellRegion, TypedLabelAction[]> {
  try {
    assertTypedLabelPlanIntegrity(plan);
  } catch {
    throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan provenance is invalid.', retryable: false, correlationId: 'cor_csv_adapter' });
  }
  if (
    plan.inputDigest !== source.digest
    || plan.extractionRevision !== source.extractionRevision
    || plan.writer.id !== csvWriterDescriptor.id
    || plan.writer.version !== csvWriterDescriptor.version
  ) {
    throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan does not match this CSV input.', retryable: false, correlationId: 'cor_csv_adapter' });
  }
  if (
    !Number.isSafeInteger(plan.expectedActionCount)
    || plan.expectedActionCount < 0
    || plan.expectedActionCount > maximumPlanActions
    || plan.expectedActionCount !== plan.actions.length
  ) {
    throw new SafeError({ code: 'REDACTION_COUNT_MISMATCH', message: 'The redaction plan action count is invalid.', retryable: false, correlationId: 'cor_csv_adapter' });
  }
  const sourceLength = unicodeCodePointLength(source.text);
  const actionIds = new Set<string>();
  const sorted = [...plan.actions].sort((left, right) => left.start - right.start || left.end - right.end);
  for (const action of sorted) {
    if (
      !actionIdPattern.test(action.id)
      || actionIds.has(action.id)
      || !Number.isSafeInteger(action.start)
      || !Number.isSafeInteger(action.end)
      || action.start < 0
      || action.start >= action.end
      || action.end > sourceLength
      || typeof action.replacement !== 'string'
      || unicodeCodePointLength(action.replacement) > 500
    ) {
      throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan actions are invalid.', retryable: false, correlationId: 'cor_csv_adapter' });
    }
    actionIds.add(action.id);
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if ((sorted[index - 1]?.end ?? 0) > (sorted[index]?.start ?? 0)) {
      throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan contains overlapping actions.', retryable: false, correlationId: 'cor_csv_adapter' });
    }
  }
  const assigned = new Map<CsvCellRegion, TypedLabelAction[]>();
  let regionIndex = 0;
  for (const action of sorted) {
    let region = regions[regionIndex];
    while (region !== undefined && action.start >= region.canonicalEnd) {
      regionIndex += 1;
      region = regions[regionIndex];
    }
    if (region === undefined || action.start < region.canonicalStart || action.end > region.canonicalEnd) {
      throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'A redaction action crosses a CSV cell boundary.', retryable: false, correlationId: 'cor_csv_adapter' });
    }
    const actions = assigned.get(region) ?? [];
    actions.push(action);
    assigned.set(region, actions);
  }
  return assigned;
}

function encodeCell(value: string, delimiter: CsvDelimiter, quoted: boolean): string {
  const mustQuote = quoted
    || supportedDelimiters.some((candidate) => value.includes(candidate))
    || value.includes('"')
    || value.includes('\r')
    || value.includes('\n');
  return mustQuote ? `"${value.replaceAll('"', '""')}"` : value;
}

function applyCsvPlan(source: CsvArtifact, plan: TypedLabelPlan): string {
  const state = csvArtifactStates.get(source);
  if (state === undefined) {
    throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The CSV extraction state is unavailable.', retryable: false, correlationId: 'cor_csv_adapter' });
  }
  const assigned = assertPlan(plan, source, state.regions);
  const changed = [...assigned.entries()].sort(([left], [right]) => left.rawStart - right.rawStart);
  const output: string[] = [];
  let rawCursor = 0;
  for (const [region, actions] of changed) {
    const replacement = encodeCell(transformValue(region.value, actions, region.canonicalStart), state.delimiter, region.quoted);
    output.push(state.rawText.slice(rawCursor, region.rawStart), replacement);
    rawCursor = region.rawEnd;
  }
  output.push(state.rawText.slice(rawCursor));
  return output.join('');
}

function createReceipt(plan: TypedLabelPlan, staged: Pick<StagedTextArtifact, 'digest' | 'byteLength'>): WriterReceipt {
  const unsigned: Omit<WriterReceipt, 'receiptDigest'> = {
    schemaVersion: '1.0.0',
    planDigest: parseSha256Digest(plan.digest),
    writer: { id: csvWriterDescriptor.id, version: csvWriterDescriptor.version },
    stagedDigest: staged.digest,
    stagedByteLength: staged.byteLength,
    expectedActionCount: plan.expectedActionCount,
    appliedActionCount: plan.actions.length,
    appliedActionIds: plan.actions.map(({ id }) => id)
  };
  return Object.freeze({ ...unsigned, receiptDigest: parseSha256Digest(computeWriterReceiptDigest(unsigned)) });
}

export function createLocalCsvArtifactSession(
  inputPath: string,
  outputPath?: string,
  maximumInputBytes = defaultMaximumCsvInputBytes,
  options: CsvExtractionOptions = defaultCsvExtractionOptions,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
) {
  if (!Number.isSafeInteger(maximumInputBytes) || maximumInputBytes < 0 || maximumInputBytes > defaultMaximumCsvInputBytes) {
    throw new TypeError('Maximum CSV input bytes must be within the adapter limit.');
  }
  const selectedOptions = validatedExtractionOptions(options);
  let sourcePromise: Promise<CsvArtifact> | undefined;
  const input = async (signal?: AbortSignal): Promise<CsvArtifact> => {
    signal?.throwIfAborted();
    sourcePromise ??= readCsvArtifact(inputPath, maximumInputBytes, selectedOptions, fileSystem);
    const source = await sourcePromise;
    signal?.throwIfAborted();
    return source;
  };
  return {
    writer: csvWriterDescriptor,
    input,
    async stage(plan: TypedLabelPlan, signal?: AbortSignal): Promise<StagedTextArtifact> {
      signal?.throwIfAborted();
      const source = await input(signal);
      const transformed = applyCsvPlan(source, plan);
      const target = outputPath === undefined ? deriveRedactedOutputPath(source.path) : resolve(outputPath);
      if (extname(target).toLowerCase() !== '.csv') {
        throw new SafeError({ code: 'FORMAT_UNSUPPORTED', message: 'A CSV output path must use the .csv extension.', retryable: false, correlationId: 'cor_csv_adapter' });
      }
      const base = await stageTextArtifact(source, target, transformed, fileSystem);
      const staged = Object.freeze({ ...base, receipt: createReceipt(plan, base) });
      try {
        signal?.throwIfAborted();
      } catch (error: unknown) {
        await discardStagedTextArtifact(staged, fileSystem);
        throw error;
      }
      return staged;
    },
    async reopen(staged: StagedTextArtifact, signal?: AbortSignal): Promise<CsvArtifact> {
      signal?.throwIfAborted();
      const reopened = await readCsvArtifact(staged.path, defaultMaximumCsvInputBytes, selectedOptions, fileSystem);
      signal?.throwIfAborted();
      if (reopened.digest !== staged.digest || reopened.byteLength !== staged.byteLength) {
        throw new SafeError({ code: 'ARTIFACT_DIGEST_MISMATCH', message: 'The staged CSV artifact changed before it could be reopened.', retryable: false, correlationId: 'cor_csv_adapter' });
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
