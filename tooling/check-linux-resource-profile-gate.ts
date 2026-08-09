import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  truncate,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface CapturedChild {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface FileSnapshot {
  readonly digest: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly links: string;
  readonly uid: string;
  readonly gid: string;
  readonly size: string;
  readonly accessedNs: string;
  readonly modifiedNs: string;
  readonly changedNs: string;
  readonly createdNs: string;
}

interface ResourceFixture {
  readonly root: string;
  readonly outputDirectory: string;
  readonly source: string;
  readonly verified: string;
  readonly sourceSnapshot: FileSnapshot;
  readonly verifiedSnapshot: FileSnapshot;
}

type Operation = 'inspect' | 'scan' | 'verify' | 'redact';

interface Workload {
  readonly label: string;
  readonly bytes: number;
  readonly fill: 'ascii' | 'unicode';
  readonly operations: readonly Operation[];
  readonly maximumRssKiB: number;
}

interface TimedResult extends CapturedChild {
  readonly maximumRssKiB: number;
}

interface TemporaryByteEvidence {
  readonly logicalBytes: bigint;
  readonly allocatedBytes: bigint;
  readonly linkedAllocatedBytes: bigint;
}

const repositoryRoot = resolve(import.meta.dirname, '..');
const cliEntry = resolve(repositoryRoot, 'apps/cli/dist/index.js');
const phaseGate = resolve(import.meta.dirname, 'filesystem-failure-phase-gate.cjs');
const timePath = '/usr/bin/time';
const maximumInputBytes = 100 * 1024 * 1024;
const coldRunCount = 3;
const childTimeoutMs = 120_000;
const checkpointTimeoutMs = 180_000;
const shutdownTimeoutMs = 2_000;
const maximumCapturedBytes = 512 * 1024;
const fixtureChunkBytes = 64 * 1024;
const kibibytesPerMebibyte = 1024;
const startupMaximumRssKiB = 192 * kibibytesPerMebibyte;
const oversizeMaximumRssKiB = 192 * kibibytesPerMebibyte;
const sourcePrefix = Buffer.from('Contact alpha@example.test.\n', 'utf8');
const verifiedPrefix = Buffer.from('Contact [EMAIL_1].\n', 'utf8');
const stagePattern = /^\..+\.[0-9a-f-]+\.staged\.(?:txt|md|markdown)$/u;

const workloads: readonly Workload[] = [
  {
    label: 'small-1mib-ascii',
    bytes: 1024 * 1024,
    fill: 'ascii',
    operations: ['inspect', 'scan', 'verify', 'redact'],
    maximumRssKiB: 256 * kibibytesPerMebibyte
  },
  {
    label: 'medium-8mib-ascii',
    bytes: 8 * 1024 * 1024,
    fill: 'ascii',
    operations: ['inspect', 'scan', 'verify', 'redact'],
    maximumRssKiB: 1024 * kibibytesPerMebibyte
  },
  {
    label: 'medium-25mib-unicode',
    bytes: 25 * 1024 * 1024,
    fill: 'unicode',
    operations: ['scan', 'redact'],
    maximumRssKiB: 1024 * kibibytesPerMebibyte
  }
];

export function parseMaximumRssKiB(value: string): number {
  const normalized = value.trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new TypeError('Resource metric was not a positive integer.');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new TypeError('Resource metric exceeded the safe integer range.');
  return parsed;
}

export function summarizeColdRuns(values: readonly number[]): Readonly<{
  minimum: number;
  median: number;
  maximum: number;
}> {
  if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError('Cold-run metrics must be non-empty positive integers.');
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minimum: sorted[0] ?? 0,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    maximum: sorted.at(-1) ?? 0
  };
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

async function spawnBounded(
  command: string,
  args: readonly string[],
  cwd: string,
  options: {
    readonly timeoutMs?: number;
    readonly env?: NodeJS.ProcessEnv;
    readonly checkpoints?: ReadonlyMap<string, () => Promise<void>>;
  } = {}
): Promise<CapturedChild> {
  return await new Promise((resolveResult, reject) => {
    const checkpoints = options.checkpoints ?? new Map<string, () => Promise<void>>();
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: { ...process.env, NODE_OPTIONS: undefined, ...options.env },
      stdio: checkpoints.size === 0 ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'ipc']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let failure: string | undefined;
    let settled = false;
    let checkpointChain = Promise.resolve();
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
          reject(new Error('Resource-profile child did not stop within its shutdown bound.'));
        });
      }, shutdownTimeoutMs);
    };
    const capture = (destination: Buffer[], chunk: Buffer): void => {
      capturedBytes += chunk.byteLength;
      if (capturedBytes > maximumCapturedBytes) {
        fail('Resource-profile child exceeded its output bound.');
        return;
      }
      destination.push(chunk);
    };
    const timeoutTimer = setTimeout(() => {
      fail('Resource-profile child exceeded its time bound.');
    }, options.timeoutMs ?? childTimeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      capture(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      capture(stderr, chunk);
    });
    child.on('message', (message: unknown) => {
      checkpointChain = checkpointChain.then(async () => {
        if (
          message === null
          || typeof message !== 'object'
          || !('type' in message)
          || !('checkpoint' in message)
          || message.type !== 'LOCAL_PII_FILESYSTEM_PHASE'
          || typeof message.checkpoint !== 'string'
        ) throw new Error('Resource-profile child sent an invalid checkpoint.');
        const action = checkpoints.get(message.checkpoint);
        if (action === undefined) throw new Error('Resource-profile child reached an unexpected checkpoint.');
        await action();
        child.send({ type: 'LOCAL_PII_FILESYSTEM_PHASE_CONTINUE', checkpoint: message.checkpoint });
      }).catch(() => {
        fail('Resource-profile checkpoint coordination failed.');
      });
    });
    child.once('error', () => {
      if (child.pid === undefined) {
        finish(() => {
          reject(new Error('Resource-profile child could not be started.'));
        });
        return;
      }
      fail('Resource-profile child communication failed.');
    });
    child.once('close', (code, signal) => {
      void checkpointChain.then(() => {
        finish(() => {
          if (failure !== undefined) {
            reject(new Error(failure));
            return;
          }
          if (signal !== null) {
            reject(new Error('Resource-profile child terminated by signal.'));
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
  });
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveResult, reject) => {
    const stream = createReadStream(path, { highWaterMark: fixtureChunkBytes });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolveResult);
  });
  return hash.digest('hex');
}

async function snapshot(path: string): Promise<FileSnapshot> {
  const [digest, metadata] = await Promise.all([digestFile(path), stat(path, { bigint: true })]);
  return {
    digest,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    mode: String(metadata.mode),
    links: String(metadata.nlink),
    uid: String(metadata.uid),
    gid: String(metadata.gid),
    size: String(metadata.size),
    accessedNs: String(metadata.atimeNs),
    modifiedNs: String(metadata.mtimeNs),
    changedNs: String(metadata.ctimeNs),
    createdNs: String(metadata.birthtimeNs)
  };
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error('Synthetic fixture write made no progress.');
    offset += bytesWritten;
  }
}

async function writeSyntheticFile(
  path: string,
  totalBytes: number,
  prefix: Buffer,
  fill: 'ascii' | 'unicode'
): Promise<void> {
  if (prefix.byteLength > totalBytes) throw new Error('Synthetic fixture prefix exceeded its byte profile.');
  const handle = await open(path, 'wx', 0o600);
  try {
    await writeAll(handle, prefix);
    let remaining = totalBytes - prefix.byteLength;
    const unit = fill === 'ascii' ? Buffer.from('x') : Buffer.from('🚦', 'utf8');
    const unitsPerChunk = Math.max(1, Math.floor(fixtureChunkBytes / unit.byteLength));
    const chunk = Buffer.from(unit.toString('utf8').repeat(unitsPerChunk), 'utf8');
    while (remaining >= chunk.byteLength) {
      await writeAll(handle, chunk);
      remaining -= chunk.byteLength;
    }
    const wholeUnits = Math.floor(remaining / unit.byteLength);
    if (wholeUnits > 0) {
      const tail = Buffer.from(unit.toString('utf8').repeat(wholeUnits), 'utf8');
      await writeAll(handle, tail);
      remaining -= tail.byteLength;
    }
    if (remaining > 0) await writeAll(handle, Buffer.alloc(remaining, 'x'));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createFixture(parent: string, workload: Workload): Promise<ResourceFixture> {
  const root = await mkdtemp(join(parent, `${workload.label}-`));
  const fixtureDirectory = join(root, 'fixtures');
  const outputDirectory = join(root, 'outputs');
  const source = join(fixtureDirectory, 'synthetic-source.txt');
  const verified = join(fixtureDirectory, 'synthetic-verified.txt');
  await Promise.all([mkdir(fixtureDirectory, { mode: 0o700 }), mkdir(outputDirectory, { mode: 0o700 })]);
  await writeSyntheticFile(source, workload.bytes, sourcePrefix, workload.fill);
  const verifiedBytes = workload.bytes - sourcePrefix.byteLength + verifiedPrefix.byteLength;
  await writeSyntheticFile(verified, verifiedBytes, verifiedPrefix, workload.fill);
  const futureAccess = new Date(Date.now() + 60_000);
  const pastModification = new Date(Date.now() - 60_000);
  await Promise.all([
    utimes(source, futureAccess, pastModification),
    utimes(verified, futureAccess, pastModification)
  ]);
  const [sourceSnapshot, verifiedSnapshot] = await Promise.all([snapshot(source), snapshot(verified)]);
  return { root, outputDirectory, source, verified, sourceSnapshot, verifiedSnapshot };
}

function forbiddenValues(fixture: ResourceFixture, output?: string): readonly string[] {
  return [
    fixture.root,
    fixture.source,
    fixture.verified,
    ...(output === undefined ? [] : [output]),
    'alpha@example.test',
    '[EMAIL_1]'
  ];
}

function assertNoLeaks(label: string, captured: CapturedChild, forbidden: readonly string[]): void {
  const combined = `${captured.stdout}${captured.stderr}`;
  for (const value of forbidden) {
    if (value.length > 0 && combined.includes(value)) {
      throw new Error(`${label} exposed a path or synthetic value.`);
    }
  }
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

function assertSuccess(
  label: string,
  operation: Operation,
  result: CapturedChild,
  inputBytes: number,
  outputBytes?: number
): void {
  if (result.exitCode !== 0 || result.stderr.length !== 0) throw new Error(`${label} did not return success.`);
  const report = parsedJson(label, result.stdout);
  if (operation === 'inspect') {
    if (report.operation !== 'INSPECT' || report.outcome !== 'SUCCEEDED' || nestedRecord(report, 'artifact').byteLength !== inputBytes) {
      throw new Error(`${label} returned an incoherent inspect report.`);
    }
  } else if (operation === 'scan') {
    const counts = nestedRecord(report, 'counts');
    if (report.operation !== 'SCAN' || report.outcome !== 'SUCCEEDED' || nestedRecord(report, 'input').byteLength !== inputBytes
      || counts.detections !== 1 || counts.conflicts !== 0) {
      throw new Error(`${label} returned an incoherent scan report.`);
    }
  } else if (operation === 'verify') {
    if (report.operation !== 'VERIFY' || report.outcome !== 'PASS' || nestedRecord(report, 'artifact').byteLength !== inputBytes) {
      throw new Error(`${label} returned an incoherent verification report.`);
    }
  } else if (
    report.operation !== 'REDACT'
    || report.outcome !== 'VERIFIED'
    || nestedRecord(report, 'input').byteLength !== inputBytes
    || nestedRecord(report, 'output').byteLength !== outputBytes
  ) {
    throw new Error(`${label} returned an incoherent redaction report.`);
  }
}

async function assertUnchanged(path: string, expected: FileSnapshot, label: string): Promise<void> {
  if (JSON.stringify(await snapshot(path)) !== JSON.stringify(expected)) {
    throw new Error(`${label} changed synthetic input bytes or metadata.`);
  }
}

async function stageNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => stagePattern.test(name)).sort();
}

async function runTimed(
  root: string,
  label: string,
  argv: readonly string[],
  maximumRssKiB: number,
  forbidden: readonly string[]
): Promise<TimedResult> {
  const metric = join(root, `.rss-${label}.txt`);
  await writeFile(metric, '', { mode: 0o600, flag: 'wx' });
  try {
    const result = await spawnBounded(timePath, [
      '-q', '-f', '%M', '-o', metric,
      process.execPath, cliEntry, ...argv
    ], root);
    assertNoLeaks(label, result, forbidden);
    const maximumRss = parseMaximumRssKiB(await readFile(metric, 'utf8'));
    if (maximumRss > maximumRssKiB) throw new Error(`${label} exceeded its absolute peak-RSS ceiling.`);
    return { ...result, maximumRssKiB: maximumRss };
  } finally {
    await rm(metric, { force: true });
  }
}

function argvFor(operation: Operation, fixture: ResourceFixture, output: string): readonly string[] {
  if (operation === 'verify') return ['verify', fixture.verified, '--json'];
  if (operation === 'redact') return ['redact', fixture.source, '--output', output, '--json'];
  return [operation, fixture.source, '--json'];
}

async function runWorkload(fixture: ResourceFixture, workload: Workload): Promise<void> {
  for (const operation of workload.operations) {
    const observed: number[] = [];
    for (let run = 0; run < coldRunCount; run += 1) {
      const output = join(fixture.outputDirectory, `${operation}-${String(run)}.txt`);
      const label = `${workload.label}-${operation}-${String(run)}`;
      const inputSnapshot = operation === 'verify' ? fixture.verifiedSnapshot : fixture.sourceSnapshot;
      const inputPath = operation === 'verify' ? fixture.verified : fixture.source;
      const result = await runTimed(
        fixture.root,
        label,
        argvFor(operation, fixture, output),
        workload.maximumRssKiB,
        forbiddenValues(fixture, output)
      );
      assertSuccess(
        label,
        operation,
        result,
        Number(inputSnapshot.size),
        operation === 'redact' ? Number(fixture.verifiedSnapshot.size) : undefined
      );
      await assertUnchanged(inputPath, inputSnapshot, label);
      if (operation === 'redact') {
        if ((await digestFile(output)) !== fixture.verifiedSnapshot.digest) throw new Error(`${label} published unexpected bytes.`);
        const publishedMetadata = await stat(output, { bigint: true });
        if (
          publishedMetadata.size !== BigInt(fixture.verifiedSnapshot.size)
          || (publishedMetadata.mode & 0o777n) !== 0o600n
          || publishedMetadata.nlink !== 1n
        ) throw new Error(`${label} published an output with unexpected metadata.`);
        await rm(output);
      } else {
        try {
          await lstat(output);
          throw new Error(`${label} created an unexpected output.`);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if ((await stageNames(fixture.outputDirectory)).length !== 0) throw new Error(`${label} retained a private stage.`);
      observed.push(result.maximumRssKiB);
    }
    const summary = summarizeColdRuns(observed);
    console.log(`Linux resource profile ${workload.label}/${operation}: RSS KiB min=${String(summary.minimum)} median=${String(summary.median)} max=${String(summary.maximum)} ceiling=${String(workload.maximumRssKiB)}.`);
  }
}

async function runStartupProfile(parent: string): Promise<void> {
  const root = await mkdtemp(join(parent, 'startup-'));
  const observed: number[] = [];
  try {
    for (let run = 0; run < coldRunCount; run += 1) {
      const label = `startup-${String(run)}`;
      const result = await runTimed(root, label, ['capabilities', '--json'], startupMaximumRssKiB, [root]);
      if (result.exitCode !== 0 || result.stderr.length !== 0) throw new Error('Startup profile did not succeed.');
      const report = parsedJson(label, result.stdout);
      if (report.engineMode !== 'RULES_ONLY' || nestedRecord(report, 'limits').maximumInputBytes !== maximumInputBytes) {
        throw new Error('Startup profile returned an incoherent capability manifest.');
      }
      observed.push(result.maximumRssKiB);
    }
    const summary = summarizeColdRuns(observed);
    console.log(`Linux resource profile startup: RSS KiB min=${String(summary.minimum)} median=${String(summary.median)} max=${String(summary.maximum)} ceiling=${String(startupMaximumRssKiB)}.`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runOversizeProfile(parent: string): Promise<void> {
  const root = await mkdtemp(join(parent, 'oversize-'));
  const source = join(root, 'synthetic-oversize.txt');
  await writeFile(source, '', { mode: 0o600, flag: 'wx' });
  await truncate(source, maximumInputBytes + 1);
  const futureAccess = new Date(Date.now() + 60_000);
  const pastModification = new Date(Date.now() - 60_000);
  await utimes(source, futureAccess, pastModification);
  const before = await snapshot(source);
  const observed: number[] = [];
  try {
    for (let run = 0; run < coldRunCount; run += 1) {
      const label = `oversize-${String(run)}`;
      const result = await runTimed(root, label, ['inspect', source, '--json'], oversizeMaximumRssKiB, [root, source]);
      if (result.exitCode !== 3 || result.stdout.length !== 0) throw new Error('Oversize profile did not return the processing failure exit.');
      const expected = {
        schemaVersion: '1.0.0',
        error: {
          code: 'INPUT_TOO_LARGE',
          message: 'The input exceeds the configured byte limit.',
          retryable: false,
          correlationId: 'cor_text_adapter'
        }
      };
      if (JSON.stringify(parsedJson(label, result.stderr)) !== JSON.stringify(expected)) {
        throw new Error('Oversize profile did not return the canonical safe error.');
      }
      await assertUnchanged(source, before, label);
      observed.push(result.maximumRssKiB);
    }
    const summary = summarizeColdRuns(observed);
    console.log(`Linux resource profile oversize: RSS KiB min=${String(summary.minimum)} median=${String(summary.median)} max=${String(summary.maximum)} ceiling=${String(oversizeMaximumRssKiB)}.`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runTemporaryByteEvidence(fixture: ResourceFixture): Promise<TemporaryByteEvidence> {
  const output = join(fixture.outputDirectory, 'temporary-byte-evidence.txt');
  let stagePath = '';
  let logicalBytes = 0n;
  let allocatedBytes = 0n;
  let linkedAllocatedBytes = 0n;
  const checkpoints = new Map<string, () => Promise<void>>([
    ['FIRST_STAGE_READ_AFTER', async () => {
      const names = await stageNames(fixture.outputDirectory);
      if (names.length !== 1) throw new Error('Temporary-byte evidence did not observe exactly one private stage.');
      stagePath = join(fixture.outputDirectory, names[0] ?? '');
      const [metadata, filesystem] = await Promise.all([
        stat(stagePath, { bigint: true }),
        statfs(fixture.outputDirectory, { bigint: true })
      ]);
      logicalBytes = metadata.size;
      allocatedBytes = metadata.blocks * 512n;
      const roundedLogical = ((logicalBytes + filesystem.bsize - 1n) / filesystem.bsize) * filesystem.bsize;
      if ((metadata.mode & 0o777n) !== 0o600n || logicalBytes !== BigInt(fixture.verifiedSnapshot.size)
        || allocatedBytes > roundedLogical) {
        throw new Error('Temporary-byte evidence exceeded its private-stage budget.');
      }
    }],
    ['PUBLICATION_LINK_AFTER', async () => {
      if (stagePath.length === 0) throw new Error('Temporary-byte evidence reached publication without a stage.');
      const [stageMetadata, outputMetadata] = await Promise.all([
        stat(stagePath, { bigint: true }),
        stat(output, { bigint: true })
      ]);
      if (stageMetadata.dev !== outputMetadata.dev || stageMetadata.ino !== outputMetadata.ino
        || stageMetadata.nlink < 2n || outputMetadata.nlink < 2n
        || stageMetadata.size !== outputMetadata.size || stageMetadata.blocks !== outputMetadata.blocks) {
        throw new Error('Temporary-byte evidence did not observe hard-link publication identity.');
      }
      // The two pathnames identify one inode, so allocated blocks are counted once.
      linkedAllocatedBytes = stageMetadata.blocks * 512n;
    }]
  ]);
  const result = await spawnBounded(process.execPath, [
    '--require', phaseGate,
    cliEntry,
    'redact', fixture.source, '--output', output, '--json'
  ], fixture.root, {
    timeoutMs: checkpointTimeoutMs,
    env: { LOCAL_PII_FILESYSTEM_FAILURE_PHASE: 'FIRST_STAGE_READ_AFTER,PUBLICATION_LINK_AFTER' },
    checkpoints
  });
  assertNoLeaks('temporary-byte evidence', result, forbiddenValues(fixture, output));
  assertSuccess(
    'temporary-byte evidence',
    'redact',
    result,
    Number(fixture.sourceSnapshot.size),
    Number(fixture.verifiedSnapshot.size)
  );
  if (logicalBytes === 0n || allocatedBytes === 0n || linkedAllocatedBytes !== allocatedBytes) {
    throw new Error('Temporary-byte evidence was incomplete.');
  }
  await assertUnchanged(fixture.source, fixture.sourceSnapshot, 'temporary-byte evidence');
  if ((await digestFile(output)) !== fixture.verifiedSnapshot.digest) throw new Error('Temporary-byte evidence published unexpected bytes.');
  if ((await stageNames(fixture.outputDirectory)).length !== 0) throw new Error('Temporary-byte evidence retained a private stage.');
  await rm(output);
  return { logicalBytes, allocatedBytes, linkedAllocatedBytes };
}

export async function runLinuxResourceProfileGate(): Promise<void> {
  if (process.platform !== 'linux') {
    console.log('Linux resource-profile evidence gate skipped: requires Linux and GNU time.');
    return;
  }
  await Promise.all([stat(cliEntry), stat(phaseGate), stat(timePath)]);
  const parent = await mkdtemp(join(tmpdir(), 'local-pii-resource-profile-'));
  try {
    await runStartupProfile(parent);
    await runOversizeProfile(parent);
    let largestFixture: ResourceFixture | undefined;
    for (const workload of workloads) {
      const fixture = await createFixture(parent, workload);
      try {
        await runWorkload(fixture, workload);
        if (workload.label === 'medium-25mib-unicode') largestFixture = fixture;
      } finally {
        if (largestFixture !== fixture) await rm(fixture.root, { recursive: true, force: true });
      }
    }
    if (largestFixture === undefined) throw new Error('Temporary-byte workload was unavailable.');
    try {
      const temporary = await runTemporaryByteEvidence(largestFixture);
      console.log(`Linux resource profile temporary bytes: logical=${String(temporary.logicalBytes)} allocated=${String(temporary.allocatedBytes)} linked-unique=${String(temporary.linkedAllocatedBytes)}.`);
    } finally {
      await rm(largestFixture.root, { recursive: true, force: true });
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
  console.log('Linux resource-profile evidence gate passed.');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    await runLinuxResourceProfileGate();
  } catch {
    // Never copy child output, paths, or native resource diagnostics into CI logs.
    console.error('Linux resource-profile evidence gate failed.');
    process.exitCode = 1;
  }
}
