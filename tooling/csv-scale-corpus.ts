import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

export const csvScaleCorpusSeed = 'local-pii-csv-scale-2026-09-11';

/**
 * Structural ceilings the CSV path enforces, mirrored from the private constants in
 * `packages/adapter-csv/src/index.ts` and `packages/detectors/src/index.ts`. The benchmark
 * asserts every observed outcome against {@link projectCsvScale}, so raising or lowering a
 * ceiling in either package fails here instead of silently changing the measured curve.
 */
export const csvScaleCeilings = Object.freeze({
  maximumInputBytes: 100 * 1024 * 1024,
  maximumCells: 100_000,
  maximumRows: 100_000,
  maximumCanonicalCodePoints: 10_000_000,
  maximumDetections: 10_000
});

/** Provenance recorded with every run so the corpus is auditable without being committed. */
export const csvScaleCorpusProvenance = Object.freeze({
  corpusId: 'csv-scale-bench-v1',
  generator: Object.freeze({
    id: 'local-pii-csv-scale',
    version: '1.0.0',
    seed: csvScaleCorpusSeed,
    recipe: 'tooling/csv-scale-corpus.ts#csvScaleRow'
  }),
  classification: 'SYNTHETIC',
  exclusionRules: Object.freeze([
    'No production or private documents',
    'No real personal data',
    'Reserved example domains only',
    'Never committed: generated into a process-local temporary directory and removed'
  ])
});

export type CsvScaleColumns = 1 | 5;

export interface CsvScaleSpec {
  readonly label: string;
  readonly rows: number;
  readonly columns: CsvScaleColumns;
  /** One synthetic e-mail cell every N rows; the remaining rows carry non-matching filler. */
  readonly piiEveryRows: number;
}

export type CsvScaleExpectation =
  | { readonly kind: 'SUCCEEDED' }
  | { readonly kind: 'REJECTED'; readonly code: 'INPUT_TOO_LARGE' | 'FORMAT_CORRUPT' | 'DETECTION_LIMIT_EXCEEDED' };

export interface CsvScaleProjection {
  readonly cells: number;
  readonly detections: number;
  readonly expectation: CsvScaleExpectation;
}

export interface WrittenCsvScaleCorpus {
  readonly byteLength: number;
  readonly digest: string;
}

const regions: readonly string[] = ['north-basin', 'south-ridge', 'east-flats', 'west-hollow'];
const notes: readonly string[] = [
  'routine follow up',
  'awaiting confirmation',
  'closed without action',
  'escalated for review'
];
const rowsPerChunk = 4_096;

/** Seeded, allocation-free row variation; a cryptographic digest per cell would dominate generation time. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function pick(values: readonly string[], key: string): string {
  return values[fnv1a(key) % values.length] ?? '';
}

export function assertCsvScaleSpec(spec: CsvScaleSpec): void {
  if (
    spec.label.length === 0
    || !Number.isSafeInteger(spec.rows) || spec.rows <= 0
    || !Number.isSafeInteger(spec.piiEveryRows) || spec.piiEveryRows <= 0
  ) throw new TypeError('CSV scale specification is invalid.');
}

/**
 * One LF-terminated row. Row content depends only on the seed and the row index, so a
 * smaller corpus is a byte-exact prefix of every larger one of the same shape.
 */
export function csvScaleRow(spec: CsvScaleSpec, index: number): string {
  const email = index % spec.piiEveryRows === 0 ? `case${String(index)}@example.test` : 'unlisted';
  if (spec.columns === 1) return `${email}\n`;
  const key = `${csvScaleCorpusSeed}:${String(index)}`;
  const ticket = 1000 + (fnv1a(`${key}:ticket`) % 9000);
  return [
    `R${String(index).padStart(7, '0')}`,
    pick(regions, `${key}:region`),
    email,
    `TKT-${String(ticket)}`,
    pick(notes, `${key}:note`)
  ].join(',') + '\n';
}

/** Detections, cells, and the first ceiling the pipeline reaches, in pipeline order. */
export function projectCsvScale(spec: CsvScaleSpec): CsvScaleProjection {
  assertCsvScaleSpec(spec);
  const cells = spec.rows * spec.columns;
  const detections = Math.ceil(spec.rows / spec.piiEveryRows);
  const expectation: CsvScaleExpectation =
    cells > csvScaleCeilings.maximumCells || spec.rows > csvScaleCeilings.maximumRows
      ? { kind: 'REJECTED', code: 'INPUT_TOO_LARGE' }
      : detections > csvScaleCeilings.maximumDetections
        ? { kind: 'REJECTED', code: 'DETECTION_LIMIT_EXCEEDED' }
        : { kind: 'SUCCEEDED' };
  return { cells, detections, expectation };
}

/** Streams the corpus to disk, digesting as it writes so no run ever holds the whole corpus. */
export async function writeCsvScaleCorpus(path: string, spec: CsvScaleSpec): Promise<WrittenCsvScaleCorpus> {
  assertCsvScaleSpec(spec);
  const hash = createHash('sha256');
  const handle = await open(path, 'wx', 0o600);
  let byteLength = 0;
  try {
    const pending: string[] = [];
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const bytes = Buffer.from(pending.join(''), 'utf8');
      pending.length = 0;
      hash.update(bytes);
      byteLength += bytes.byteLength;
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
        if (bytesWritten <= 0) throw new Error('CSV scale corpus write made no progress.');
        offset += bytesWritten;
      }
    };
    for (let index = 0; index < spec.rows; index += 1) {
      pending.push(csvScaleRow(spec, index));
      if (pending.length >= rowsPerChunk) await flush();
    }
    await flush();
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { byteLength, digest: `sha256:${hash.digest('hex')}` };
}
