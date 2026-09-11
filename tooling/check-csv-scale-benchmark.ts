import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parseMaximumRssKiB, summarizeColdRuns } from './check-linux-resource-profile-gate.js';
import {
  csvScaleCeilings,
  csvScaleCorpusProvenance,
  projectCsvScale,
  writeCsvScaleCorpus,
  type CsvScaleSpec
} from './csv-scale-corpus.js';

interface CapturedChild {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type Operation = 'scan' | 'redact';

interface Workload {
  readonly spec: CsvScaleSpec;
  readonly operations: readonly Operation[];
}

/** How peak RSS is obtained on this host, or why it cannot be. */
export type ResourceProbe =
  | { readonly kind: 'GNU'; readonly path: string }
  | { readonly kind: 'BSD'; readonly path: string }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

export interface RunObservation {
  readonly wallMs: number;
  readonly peakRssKiB: number | undefined;
  readonly captured: CapturedChild;
}

export type RunOutcome =
  | { readonly kind: 'SUCCEEDED'; readonly detections: number; readonly outputByteLength: number | undefined }
  | { readonly kind: 'REJECTED'; readonly code: string };

export interface CurvePoint {
  readonly label: string;
  readonly operation: Operation;
  readonly rows: number;
  readonly byteLength: number;
  readonly detections: number;
  readonly medianRssKiB: number;
}

const repositoryRoot = resolve(import.meta.dirname, '..');
const cliEntry = resolve(repositoryRoot, 'apps/cli/dist/index.js');
const timePath = '/usr/bin/time';
const coldRunCount = 3;
const childTimeoutMs = 300_000;
const shutdownTimeoutMs = 2_000;
// Scan emits one JSON object per detection, so the report alone reaches megabytes at the detection ceiling.
const maximumCapturedBytes = 8 * 1024 * 1024;
const kibibytesPerMebibyte = 1024;
const absoluteMaximumRssKiB = 1024 * kibibytesPerMebibyte;
const syntheticDomain = '@example.test';
const streamChunkBytes = 64 * 1024;

/**
 * Four decades of rows across the two shapes the adapter treats differently: a realistic
 * five-column record and the narrowest possible single-column file, which is the only shape
 * that can reach the row ceiling. Rejected workloads are part of the evidence — they show what
 * the whole-file read costs before the grammar refuses the input.
 */
const workloads: readonly Workload[] = [
  { spec: { label: 'wide-1k', rows: 1_000, columns: 5, piiEveryRows: 4 }, operations: ['scan', 'redact'] },
  { spec: { label: 'wide-10k', rows: 10_000, columns: 5, piiEveryRows: 4 }, operations: ['scan', 'redact'] },
  { spec: { label: 'wide-20k', rows: 20_000, columns: 5, piiEveryRows: 4 }, operations: ['scan', 'redact'] },
  { spec: { label: 'wide-dense-20k', rows: 20_000, columns: 5, piiEveryRows: 1 }, operations: ['scan', 'redact'] },
  { spec: { label: 'wide-100k', rows: 100_000, columns: 5, piiEveryRows: 4 }, operations: ['scan', 'redact'] },
  { spec: { label: 'wide-1m', rows: 1_000_000, columns: 5, piiEveryRows: 4 }, operations: ['scan', 'redact'] },
  { spec: { label: 'narrow-100k', rows: 100_000, columns: 1, piiEveryRows: 16 }, operations: ['scan', 'redact'] }
];

export function parsePeakRssKiB(kind: 'GNU' | 'BSD', value: string): number {
  if (kind === 'GNU') return parseMaximumRssKiB(value);
  const matched = /^\s*([0-9]+)\s+maximum resident set size$/mu.exec(value);
  if (matched?.[1] === undefined) throw new TypeError('BSD resource output did not report a peak RSS.');
  const bytes = parseMaximumRssKiB(matched[1]);
  return Math.ceil(bytes / 1024);
}

export function selectResourceProbe(platform: NodeJS.Platform, timeAvailable: boolean): ResourceProbe {
  if (!timeAvailable) return { kind: 'UNAVAILABLE', reason: `${platform} host has no /usr/bin/time` };
  if (platform === 'linux') return { kind: 'GNU', path: timePath };
  if (platform === 'darwin') return { kind: 'BSD', path: timePath };
  return { kind: 'UNAVAILABLE', reason: `${platform} resource accounting is unverified` };
}

export function resourceArgs(probe: ResourceProbe, metricPath: string): readonly string[] {
  if (probe.kind === 'GNU') return [probe.path, '-q', '-f', '%M', '-o', metricPath];
  if (probe.kind === 'BSD') return [probe.path, '-l', '-o', metricPath];
  return [];
}

function parsedJson(label: string, value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} did not return canonical JSON.`);
  }
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function countOf(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('A benchmark report field was not a count.');
  }
  return value;
}

/** Maps one CLI invocation onto the pipeline outcome the projection predicts. */
export function classifyRun(operation: Operation, captured: CapturedChild): RunOutcome {
  if (captured.exitCode === 0) {
    if (captured.stderr.length !== 0) throw new Error('A successful benchmark run wrote to stderr.');
    const report = parsedJson(`${operation} report`, captured.stdout);
    if (operation === 'scan') {
      if (report.operation !== 'SCAN' || report.outcome !== 'SUCCEEDED') throw new Error('Scan returned an incoherent report.');
      return { kind: 'SUCCEEDED', detections: countOf(nestedRecord(report, 'counts'), 'detections'), outputByteLength: undefined };
    }
    if (report.operation !== 'REDACT' || report.outcome !== 'VERIFIED') throw new Error('Redact returned an incoherent report.');
    return {
      kind: 'SUCCEEDED',
      detections: countOf(nestedRecord(report, 'plan'), 'actionCount'),
      outputByteLength: countOf(nestedRecord(report, 'output'), 'byteLength')
    };
  }
  if (captured.exitCode !== 3 || captured.stdout.length !== 0) throw new Error('A benchmark run failed outside the processing-failure exit.');
  const code = nestedRecord(parsedJson(`${operation} error`, captured.stderr), 'error').code;
  if (typeof code !== 'string') throw new Error('A rejected benchmark run returned no safe-error code.');
  return { kind: 'REJECTED', code };
}

export function formatObservation(
  label: string,
  operation: Operation,
  facts: Readonly<{ rows: number; columns: number; cells: number; byteLength: number; outcome: string }>,
  wall: Readonly<{ minimum: number; median: number; maximum: number }>,
  rss: Readonly<{ minimum: number; median: number; maximum: number }> | undefined
): string {
  const resource = rss === undefined
    ? 'RSS KiB unavailable'
    : `RSS KiB min=${String(rss.minimum)} median=${String(rss.median)} max=${String(rss.maximum)}`;
  return [
    `CSV scale ${label}/${operation}:`,
    `rows=${String(facts.rows)} columns=${String(facts.columns)} cells=${String(facts.cells)} bytes=${String(facts.byteLength)}`,
    `outcome=${facts.outcome}`,
    `wall ms min=${String(wall.minimum)} median=${String(wall.median)} max=${String(wall.maximum)}`,
    resource
  ].join(' ');
}

/**
 * Peak RSS above the empty-process baseline, attributed two ways. Input bytes drive the
 * whole-file read; detections drive the resolved spans, the plan, and the report the CLI
 * materializes, and that second term dominates every accepted workload.
 */
export function formatCurvePoint(point: CurvePoint, baselineKiB: number): string {
  const inputMiB = point.byteLength / (1024 * 1024);
  const aboveBaselineKiB = point.medianRssKiB - baselineKiB;
  const perDetection = point.detections === 0
    ? 'KiB per detection=n/a'
    : `KiB per detection=${String(Math.round(aboveBaselineKiB / point.detections))}`;
  return [
    `CSV scale curve ${point.label}/${point.operation}:`,
    `rows=${String(point.rows)} detections=${String(point.detections)} inputKiB=${String(Math.round(point.byteLength / 1024))}`,
    `RSS KiB above baseline=${String(aboveBaselineKiB)}`,
    `KiB per input MiB=${String(Math.round(aboveBaselineKiB / Math.max(inputMiB, Number.EPSILON)))}`,
    perDetection
  ].join(' ');
}

/**
 * Two runs that fail at the same cell do identical parse work, so any peak-RSS difference
 * between them is charged entirely to reading the file whole before parsing begins.
 */
export function readPathVerdict(small: CurvePoint, large: CurvePoint): Readonly<{
  bounded: boolean;
  kiBPerInputMiB: number;
}> {
  const deltaMiB = (large.byteLength - small.byteLength) / (1024 * 1024);
  if (deltaMiB <= 0) throw new TypeError('The read-path verdict needs two distinct input sizes.');
  const kiBPerInputMiB = Math.round((large.medianRssKiB - small.medianRssKiB) / deltaMiB);
  // A bounded reader would pay a constant staging cost; anything near a kibibyte per kibibyte is a whole-file read.
  return { bounded: kiBPerInputMiB < 128, kiBPerInputMiB };
}

function killChild(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    child.kill('SIGKILL');
  }
}

/**
 * A leaner sibling of the resource gate's bounded spawn: the benchmark needs no checkpoint IPC
 * and a far larger capture bound, because a scan report at the detection ceiling is megabytes.
 */
async function spawnCaptured(command: string, args: readonly string[], cwd: string): Promise<CapturedChild> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: { ...process.env, NODE_OPTIONS: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let failure: string | undefined;
    let settled = false;
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
      callback();
    };
    const fail = (message: string): void => {
      if (failure !== undefined) return;
      failure = message;
      try {
        killChild(child);
      } catch {
        // Preserve the privacy-safe bounded failure below.
      }
      shutdownTimer = setTimeout(() => {
        finish(() => {
          reject(new Error('CSV scale child did not stop within its shutdown bound.'));
        });
      }, shutdownTimeoutMs);
    };
    const capture = (destination: Buffer[], chunk: Buffer): void => {
      capturedBytes += chunk.byteLength;
      if (capturedBytes > maximumCapturedBytes) {
        fail('CSV scale child exceeded its output bound.');
        return;
      }
      destination.push(chunk);
    };
    const timeoutTimer = setTimeout(() => {
      fail('CSV scale child exceeded its time bound.');
    }, childTimeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      capture(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      capture(stderr, chunk);
    });
    child.once('error', () => {
      if (child.pid === undefined) {
        finish(() => {
          reject(new Error('CSV scale child could not be started.'));
        });
        return;
      }
      fail('CSV scale child communication failed.');
    });
    child.once('close', (code, signal) => {
      finish(() => {
        if (failure !== undefined) {
          reject(new Error(failure));
          return;
        }
        if (signal !== null) {
          reject(new Error('CSV scale child terminated by signal.'));
          return;
        }
        resolveResult({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8')
        });
      });
    });
  });
}

async function runMeasured(
  root: string,
  probe: ResourceProbe,
  label: string,
  argv: readonly string[]
): Promise<RunObservation> {
  const metric = join(root, `.rss-${label}.txt`);
  if (probe.kind !== 'UNAVAILABLE') await writeFile(metric, '', { mode: 0o600, flag: 'w' });
  try {
    const prefix = resourceArgs(probe, metric);
    const command = prefix[0] ?? process.execPath;
    const args = prefix.length === 0
      ? [cliEntry, ...argv]
      : [...prefix.slice(1), process.execPath, cliEntry, ...argv];
    const started = process.hrtime.bigint();
    const captured = await spawnCaptured(command, args, root);
    const wallMs = Math.max(1, Number((process.hrtime.bigint() - started) / 1_000_000n));
    if (probe.kind === 'UNAVAILABLE') return { wallMs, peakRssKiB: undefined, captured };
    const peakRssKiB = parsePeakRssKiB(probe.kind, await readFile(metric, 'utf8'));
    if (peakRssKiB > absoluteMaximumRssKiB) throw new Error(`${label} exceeded its absolute peak-RSS ceiling.`);
    return { wallMs, peakRssKiB, captured };
  } finally {
    await rm(metric, { force: true });
  }
}

function assertNoLeaks(label: string, captured: CapturedChild, forbidden: readonly string[]): void {
  const combined = `${captured.stdout}${captured.stderr}`;
  for (const value of forbidden) {
    if (value.length > 0 && combined.includes(value)) throw new Error(`${label} exposed a path or synthetic value.`);
  }
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveResult, reject) => {
    const stream = createReadStream(path, { highWaterMark: streamChunkBytes });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolveResult);
  });
  return hash.digest('hex');
}

/** Streams the published artifact so the leakage check never holds a redacted corpus in memory. */
async function containsSyntheticDomain(path: string): Promise<boolean> {
  return await new Promise((resolveResult, reject) => {
    const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: streamChunkBytes });
    let carry = '';
    stream.on('data', (chunk: string | Buffer) => {
      const window = `${carry}${String(chunk)}`;
      if (window.includes(syntheticDomain)) {
        stream.destroy();
        resolveResult(true);
        return;
      }
      carry = window.slice(-syntheticDomain.length);
    });
    stream.once('error', reject);
    stream.once('close', () => {
      resolveResult(false);
    });
  });
}

function outcomeLabel(outcome: RunOutcome): string {
  return outcome.kind === 'SUCCEEDED' ? `SUCCEEDED detections=${String(outcome.detections)}` : `REJECTED ${outcome.code}`;
}

async function runWorkload(parent: string, probe: ResourceProbe, workload: Workload): Promise<readonly CurvePoint[]> {
  const { spec } = workload;
  const projection = projectCsvScale(spec);
  const root = await mkdtemp(join(parent, `${spec.label}-`));
  const corpus = join(root, 'corpus.csv');
  const output = join(root, 'redacted.csv');
  const curve: CurvePoint[] = [];
  try {
    const written = await writeCsvScaleCorpus(corpus, spec);
    if (written.byteLength > csvScaleCeilings.maximumInputBytes) throw new Error(`${spec.label} exceeded the adapter byte limit.`);
    const corpusDigest = await digestFile(corpus);
    const forbidden = [root, corpus, output, syntheticDomain];
    for (const operation of workload.operations) {
      const walls: number[] = [];
      const peaks: number[] = [];
      let outputDigest: string | undefined;
      let outcome: RunOutcome | undefined;
      for (let run = 0; run < coldRunCount; run += 1) {
        const label = `${spec.label}-${operation}-${String(run)}`;
        const argv = operation === 'scan'
          ? ['scan', corpus, '--json']
          : ['redact', corpus, '--output', output, '--json'];
        const observation = await runMeasured(root, probe, label, argv);
        assertNoLeaks(label, observation.captured, forbidden);
        const classified = classifyRun(operation, observation.captured);
        if (classified.kind !== projection.expectation.kind) throw new Error(`${label} did not reach its projected ceiling.`);
        if (classified.kind === 'REJECTED' && projection.expectation.kind === 'REJECTED'
          && classified.code !== projection.expectation.code) {
          throw new Error(`${label} was rejected by an unprojected ceiling.`);
        }
        if (classified.kind === 'SUCCEEDED' && classified.detections !== projection.detections) {
          throw new Error(`${label} produced an unprojected detection count.`);
        }
        if (await digestFile(corpus) !== corpusDigest) throw new Error(`${label} changed the synthetic input.`);
        if (classified.kind === 'SUCCEEDED' && operation === 'redact') {
          if (await containsSyntheticDomain(output)) throw new Error(`${label} published an unredacted synthetic value.`);
          const digest = await digestFile(output);
          if (outputDigest !== undefined && digest !== outputDigest) throw new Error(`${label} published non-deterministic bytes.`);
          outputDigest = digest;
          await rm(output);
        } else {
          await rm(output, { force: true });
        }
        walls.push(observation.wallMs);
        if (observation.peakRssKiB !== undefined) peaks.push(observation.peakRssKiB);
        outcome = classified;
      }
      if (outcome === undefined) throw new Error(`${spec.label} produced no observations.`);
      const rss = peaks.length === coldRunCount ? summarizeColdRuns(peaks) : undefined;
      console.log(formatObservation(
        spec.label,
        operation,
        {
          rows: spec.rows,
          columns: spec.columns,
          cells: projection.cells,
          byteLength: written.byteLength,
          outcome: outcomeLabel(outcome)
        },
        summarizeColdRuns(walls),
        rss
      ));
      if (rss !== undefined) {
        curve.push({
          label: spec.label,
          operation,
          rows: spec.rows,
          byteLength: written.byteLength,
          detections: outcome.kind === 'SUCCEEDED' ? outcome.detections : 0,
          medianRssKiB: rss.median
        });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return curve;
}

async function measureBaseline(parent: string, probe: ResourceProbe): Promise<number | undefined> {
  const root = await mkdtemp(join(parent, 'baseline-'));
  try {
    const peaks: number[] = [];
    for (let run = 0; run < coldRunCount; run += 1) {
      const observation = await runMeasured(root, probe, `baseline-${String(run)}`, ['capabilities', '--json']);
      if (observation.captured.exitCode !== 0) throw new Error('Baseline profile did not succeed.');
      if (observation.peakRssKiB === undefined) return undefined;
      peaks.push(observation.peakRssKiB);
    }
    return summarizeColdRuns(peaks).median;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runCsvScaleBenchmark(): Promise<void> {
  await stat(cliEntry);
  const probe = selectResourceProbe(process.platform, await stat(timePath).then(() => true, () => false));
  console.log(`CSV scale benchmark corpus ${csvScaleCorpusProvenance.corpusId} seed ${csvScaleCorpusProvenance.generator.seed} (${csvScaleCorpusProvenance.classification}).`);
  console.log(probe.kind === 'UNAVAILABLE'
    ? `CSV scale benchmark peak RSS unavailable: ${probe.reason}; wall time only.`
    : `CSV scale benchmark peak RSS via ${probe.kind} resource accounting.`);
  const parent = await mkdtemp(join(tmpdir(), 'local-pii-csv-scale-'));
  try {
    const baseline = await measureBaseline(parent, probe);
    if (baseline !== undefined) console.log(`CSV scale baseline: RSS KiB median=${String(baseline)} for an empty capability query.`);
    const curve: CurvePoint[] = [];
    for (const workload of workloads) curve.push(...await runWorkload(parent, probe, workload));
    if (baseline !== undefined) {
      for (const point of curve) console.log(formatCurvePoint(point, baseline));
      const small = curve.find(({ label, operation }) => label === 'wide-100k' && operation === 'scan');
      const large = curve.find(({ label, operation }) => label === 'wide-1m' && operation === 'scan');
      if (small === undefined || large === undefined) throw new Error('The read-path comparison workloads were unavailable.');
      const verdict = readPathVerdict(small, large);
      console.log(`CSV scale read path: ${verdict.bounded ? 'BOUNDED' : 'PROPORTIONAL_TO_INPUT'} at ${String(verdict.kiBPerInputMiB)} KiB of peak RSS per input MiB across two inputs rejected at the same cell.`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
  console.log(`CSV scale benchmark completed; ceilings held at cells=${String(csvScaleCeilings.maximumCells)} rows=${String(csvScaleCeilings.maximumRows)} detections=${String(csvScaleCeilings.maximumDetections)}.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    await runCsvScaleBenchmark();
  } catch {
    // Never copy child output, paths, or native resource diagnostics into CI logs.
    console.error('CSV scale benchmark failed.');
    process.exitCode = 1;
  }
}
