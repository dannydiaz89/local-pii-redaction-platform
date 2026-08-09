import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { BigIntStats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { createSyntheticCorpus } from './synthetic-corpus.js';

type Checkpoint =
  | 'FIRST_STAGE_READ_BEFORE'
  | 'SECOND_STAGE_READ_BEFORE'
  | 'PUBLICATION_LINK_BEFORE'
  | 'PUBLICATION_LINK_REJECTED';

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

interface Scenario {
  readonly root: string;
  readonly fixtureDirectory: string;
  readonly outputDirectory: string;
  readonly source: string;
  readonly output: string;
  readonly sourceSnapshot: FileSnapshot;
  readonly existingOutputSnapshot?: FileSnapshot;
}

const repositoryRoot = resolve(import.meta.dirname, '..');
const cliEntry = resolve(repositoryRoot, 'apps/cli/dist/index.js');
const phaseGate = resolve(import.meta.dirname, 'filesystem-failure-phase-gate.cjs');
const stracePath = '/usr/bin/strace';
const bashPath = '/bin/bash';
const childTimeoutMs = 10_000;
const maximumCapturedBytes = 64 * 1024;
const stagePattern = /^\..+\.[0-9a-f-]+\.staged\.(?:txt|md|markdown)$/u;

function isCheckpoint(value: string): value is Checkpoint {
  return [
    'FIRST_STAGE_READ_BEFORE',
    'SECOND_STAGE_READ_BEFORE',
    'PUBLICATION_LINK_BEFORE',
    'PUBLICATION_LINK_REJECTED'
  ].includes(value);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function metadata(metadata: BigIntStats): Omit<FileSnapshot, 'digest'> {
  return {
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

async function snapshot(path: string): Promise<FileSnapshot> {
  const bytes = await readFile(path);
  const fileMetadata = await stat(path, { bigint: true });
  return { digest: digest(bytes), ...metadata(fileMetadata) };
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedSnapshotFields(left: FileSnapshot, right: FileSnapshot): string {
  return (Object.keys(left) as Array<keyof FileSnapshot>)
    .filter((field) => left[field] !== right[field])
    .join(',');
}

async function stages(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => stagePattern.test(name)).sort();
}

async function expectOutputAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
  }
  throw new Error(`${label} did not preserve output absence.`);
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

async function spawnCaptured(
  command: string,
  args: readonly string[],
  cwd: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly checkpoints?: ReadonlyMap<Checkpoint, () => Promise<void>>;
  } = {}
): Promise<CapturedChild> {
  return await new Promise((resolveResult, reject) => {
    const checkpoints = options.checkpoints ?? new Map<Checkpoint, () => Promise<void>>();
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: { ...process.env, NODE_OPTIONS: undefined, ...options.env },
      stdio: checkpoints.size === 0 ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'ipc']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;
    let failureMessage: string | undefined;
    let shutdownTimeout: ReturnType<typeof setTimeout> | undefined;
    let checkpointChain = Promise.resolve();
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (shutdownTimeout !== undefined) clearTimeout(shutdownTimeout);
      callback();
    };
    const fail = (message: string): void => {
      if (failureMessage !== undefined) return;
      failureMessage = message;
      try {
        killChild(child);
      } catch {
        // Preserve the bounded, privacy-safe harness failure below.
      }
      shutdownTimeout = setTimeout(() => {
        finish(() => {
          reject(new Error('Filesystem-failure child did not stop within its shutdown bound.'));
        });
      }, 2_000);
    };
    const capture = (destination: Buffer[], chunk: Buffer): void => {
      capturedBytes += chunk.byteLength;
      if (capturedBytes > maximumCapturedBytes) {
        fail('Filesystem-failure child exceeded its output bound.');
        return;
      }
      destination.push(chunk);
    };
    const timeout = setTimeout(() => {
      fail('Filesystem-failure child exceeded its time bound.');
    }, childTimeoutMs);
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
          || !isCheckpoint(message.checkpoint)
        ) throw new Error('Filesystem-failure child sent an invalid checkpoint.');
        const checkpoint = message.checkpoint;
        const action = checkpoints.get(checkpoint);
        if (action === undefined) throw new Error('Filesystem-failure child reached an unexpected checkpoint.');
        await action();
        child.send({ type: 'LOCAL_PII_FILESYSTEM_PHASE_CONTINUE', checkpoint });
      }).catch(() => {
        fail('Filesystem-failure checkpoint coordination failed.');
      });
    });
    child.once('error', () => {
      if (child.pid === undefined) {
        finish(() => {
          reject(new Error('Filesystem-failure child could not be started.'));
        });
        return;
      }
      fail('Filesystem-failure child communication failed.');
    });
    child.once('close', (code, signal) => {
      void checkpointChain.then(() => {
        finish(() => {
          if (failureMessage !== undefined) {
            reject(new Error(failureMessage));
            return;
          }
          if (signal !== null) {
            reject(new Error('Filesystem-failure child terminated by signal.'));
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

function expectedEnvelope(message: string, details?: Readonly<Record<string, string>>): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    error: {
      code: 'STORAGE_UNAVAILABLE',
      message,
      retryable: true,
      correlationId: 'cor_text_adapter',
      ...(details === undefined ? {} : { details })
    }
  };
}

function assertSafeFailure(
  label: string,
  result: CapturedChild,
  envelope: Record<string, unknown>,
  forbidden: readonly string[]
): void {
  if (result.exitCode !== 3 || result.stdout.length !== 0) {
    throw new Error(`${label} did not return the documented processing exit.`);
  }
  let actual: unknown;
  try {
    actual = JSON.parse(result.stderr) as unknown;
  } catch {
    throw new Error(`${label} did not return a canonical JSON error.`);
  }
  if (JSON.stringify(actual) !== JSON.stringify(envelope)) {
    throw new Error(`${label} did not return the expected privacy-safe error.`);
  }
  const captured = `${result.stdout}${result.stderr}`;
  for (const value of forbidden) {
    if (value.length > 0 && captured.includes(value)) {
      throw new Error(`${label} exposed a forbidden value or native detail.`);
    }
  }
}

async function createScenario(parent: string, label: string, existingOutput = false): Promise<Scenario> {
  const root = await mkdtemp(join(parent, `${label}-`));
  const fixtureDirectory = join(root, 'fixture-path-canary');
  const outputDirectory = join(root, 'output-parent-path-canary');
  const source = join(fixtureDirectory, 'source-filename-canary.txt');
  const output = join(outputDirectory, 'output-filename-canary.txt');
  const corpus = createSyntheticCorpus();
  await Promise.all([mkdir(fixtureDirectory), mkdir(outputDirectory)]);
  await writeFile(source, corpus.input, { encoding: 'utf8', mode: 0o600 });
  if (existingOutput) await writeFile(output, 'existing-output-byte-canary', { encoding: 'utf8', mode: 0o600 });
  // Give the synthetic fixture a newer access time than modification time so
  // Linux relatime reads remain observable as metadata-preserving. Strict-atime
  // filesystems will fail this evidence instead of silently weakening it.
  const accessedAt = new Date();
  const modifiedAt = new Date(accessedAt.getTime() - 60_000);
  await utimes(source, accessedAt, modifiedAt);
  if (existingOutput) await utimes(output, accessedAt, modifiedAt);
  await readFile(source);
  if (existingOutput) await readFile(output);
  return {
    root,
    fixtureDirectory,
    outputDirectory,
    source,
    output,
    sourceSnapshot: await snapshot(source),
    ...(existingOutput ? { existingOutputSnapshot: await snapshot(output) } : {})
  };
}

function cliArguments(scenario: Scenario, selectedCheckpoints: readonly Checkpoint[] = []): string[] {
  return [
    ...(selectedCheckpoints.length === 0 ? [] : ['--require', phaseGate]),
    cliEntry,
    'redact',
    scenario.source,
    '--output',
    scenario.output,
    '--json'
  ];
}

function forbiddenValues(scenario: Scenario): string[] {
  const corpus = createSyntheticCorpus();
  return [
    scenario.root,
    scenario.source,
    scenario.output,
    basename(scenario.source),
    basename(scenario.output),
    corpus.input,
    corpus.expected,
    ...corpus.canaryValues,
    'existing-output-byte-canary',
    '.staged',
    'EACCES',
    'EPERM',
    'EFBIG',
    'ENOSPC',
    'EDQUOT',
    'EMFILE',
    'permission denied',
    'file too large',
    'native errno'
  ];
}

async function runCli(
  scenario: Scenario,
  selectedCheckpoints: readonly Checkpoint[] = [],
  checkpoints: ReadonlyMap<Checkpoint, () => Promise<void>> = new Map()
): Promise<CapturedChild> {
  return await spawnCaptured(process.execPath, cliArguments(scenario, selectedCheckpoints), scenario.root, {
    ...(selectedCheckpoints.length === 0 ? {} : {
      env: { LOCAL_PII_FILESYSTEM_FAILURE_PHASE: selectedCheckpoints.join(',') },
      checkpoints
    })
  });
}

async function assertSourceUnchanged(scenario: Scenario, label: string): Promise<void> {
  const finalSnapshot = await snapshot(scenario.source);
  if (!sameSnapshot(scenario.sourceSnapshot, finalSnapshot)) {
    throw new Error(`${label} changed synthetic input fields: ${changedSnapshotFields(scenario.sourceSnapshot, finalSnapshot)}.`);
  }
}

async function restoreScenario(scenario: Scenario): Promise<void> {
  await chmod(scenario.outputDirectory, 0o700).catch(() => undefined);
  for (const name of await readdir(scenario.outputDirectory).catch(() => [] as string[])) {
    if (stagePattern.test(name)) await chmod(join(scenario.outputDirectory, name), 0o600).catch(() => undefined);
  }
}

async function runTargetCheckFailure(parent: string): Promise<void> {
  const label = 'target-check permission failure';
  const scenario = await createScenario(parent, 'target-check', true);
  try {
    await chmod(scenario.outputDirectory, 0o000);
    const result = await runCli(scenario);
    await chmod(scenario.outputDirectory, 0o700);
    assertSafeFailure(label, result, expectedEnvelope('The output location could not be checked.'), forbiddenValues(scenario));
    await assertSourceUnchanged(scenario, label);
    if (
      scenario.existingOutputSnapshot === undefined
      || !sameSnapshot(scenario.existingOutputSnapshot, await snapshot(scenario.output))
    ) throw new Error(`${label} changed the existing output bytes or observed metadata.`);
    if ((await stages(scenario.outputDirectory)).length !== 0) throw new Error(`${label} retained a private stage.`);
  } finally {
    await restoreScenario(scenario);
  }
}

async function runStageCreateFailure(parent: string): Promise<void> {
  const label = 'stage-create permission failure';
  const scenario = await createScenario(parent, 'stage-create');
  try {
    await chmod(scenario.outputDirectory, 0o555);
    const result = await runCli(scenario);
    await chmod(scenario.outputDirectory, 0o700);
    assertSafeFailure(label, result, expectedEnvelope('The staged artifact could not be created.'), forbiddenValues(scenario));
    await assertSourceUnchanged(scenario, label);
    await expectOutputAbsent(scenario.output, label);
    if ((await stages(scenario.outputDirectory)).length !== 0) throw new Error(`${label} retained a private stage.`);
  } finally {
    await restoreScenario(scenario);
  }
}

async function runFileLimitFailure(parent: string): Promise<void> {
  const label = 'stage-write file-size-limit failure';
  const scenario = await createScenario(parent, 'file-limit');
  const tracePrefix = join(scenario.root, 'private-syscall-evidence');
  try {
    const result = await spawnCaptured(stracePath, [
      '-ff',
      '-o', tracePrefix,
      '-e', 'trace=write,pwrite64',
      '-e', 'raw=write,pwrite64',
      bashPath,
      '-c',
      'trap "" XFSZ; ulimit -f 0; exec "$@"',
      'local-pii-file-limit',
      process.execPath,
      ...cliArguments(scenario)
    ], scenario.root);
    assertSafeFailure(label, result, expectedEnvelope('The staged artifact could not be written.'), forbiddenValues(scenario));
    const traceNames = (await readdir(scenario.root)).filter((name) => name.startsWith(basename(tracePrefix)));
    let observedFileLimit = false;
    for (const name of traceNames) {
      const trace = await readFile(join(scenario.root, name), 'utf8');
      if (/\b(?:write|pwrite64)\([^\n]*\)\s+=\s+-1\s+EFBIG\b/u.test(trace)) observedFileLimit = true;
      await rm(join(scenario.root, name), { force: true });
    }
    if (!observedFileLimit) throw new Error(`${label} did not observe a kernel EFBIG result.`);
    await assertSourceUnchanged(scenario, label);
    await expectOutputAbsent(scenario.output, label);
    if ((await stages(scenario.outputDirectory)).length !== 0) throw new Error(`${label} retained a private stage.`);
  } finally {
    await restoreScenario(scenario);
  }
}

async function runReadFailure(
  parent: string,
  checkpoint: 'FIRST_STAGE_READ_BEFORE' | 'SECOND_STAGE_READ_BEFORE',
  label: string,
  message: string
): Promise<void> {
  const scenario = await createScenario(parent, checkpoint === 'FIRST_STAGE_READ_BEFORE' ? 'stage-readback' : 'stage-reopen');
  try {
    const result = await runCli(scenario, [checkpoint], new Map([
      [checkpoint, async () => {
        const stageNames = await stages(scenario.outputDirectory);
        if (stageNames.length !== 1) throw new Error('Expected one private stage at the read checkpoint.');
        await chmod(join(scenario.outputDirectory, stageNames[0] ?? ''), 0o000);
      }]
    ]));
    assertSafeFailure(label, result, expectedEnvelope(message), forbiddenValues(scenario));
    await assertSourceUnchanged(scenario, label);
    await expectOutputAbsent(scenario.output, label);
    if ((await stages(scenario.outputDirectory)).length !== 0) throw new Error(`${label} retained a private stage.`);
  } finally {
    await restoreScenario(scenario);
  }
}

async function runPublicationFailure(parent: string): Promise<void> {
  const label = 'publication permission failure';
  const scenario = await createScenario(parent, 'publication');
  const selected: readonly Checkpoint[] = ['PUBLICATION_LINK_BEFORE', 'PUBLICATION_LINK_REJECTED'];
  try {
    const result = await runCli(scenario, selected, new Map([
      ['PUBLICATION_LINK_BEFORE', async () => chmod(scenario.outputDirectory, 0o555)],
      ['PUBLICATION_LINK_REJECTED', async () => chmod(scenario.outputDirectory, 0o700)]
    ]));
    assertSafeFailure(label, result, expectedEnvelope('The staged artifact could not be published.'), forbiddenValues(scenario));
    await assertSourceUnchanged(scenario, label);
    await expectOutputAbsent(scenario.output, label);
    if ((await stages(scenario.outputDirectory)).length !== 0) throw new Error(`${label} retained a private stage.`);
  } finally {
    await restoreScenario(scenario);
  }
}

async function runCleanupFailure(parent: string): Promise<void> {
  const label = 'cleanup permission failure';
  const scenario = await createScenario(parent, 'cleanup');
  let retainedStage = '';
  try {
    const result = await runCli(scenario, ['FIRST_STAGE_READ_BEFORE'], new Map([
      ['FIRST_STAGE_READ_BEFORE', async () => {
        const stageNames = await stages(scenario.outputDirectory);
        if (stageNames.length !== 1) throw new Error('Expected one private stage at the cleanup checkpoint.');
        retainedStage = join(scenario.outputDirectory, stageNames[0] ?? '');
        await chmod(retainedStage, 0o000);
        await chmod(scenario.outputDirectory, 0o555);
      }]
    ]));
    assertSafeFailure(
      label,
      result,
      expectedEnvelope('The staged artifact cleanup could not be confirmed.', { reason: 'stage_cleanup_failed' }),
      forbiddenValues(scenario)
    );
    await assertSourceUnchanged(scenario, label);
    await expectOutputAbsent(scenario.output, label);
    if ((await stages(scenario.outputDirectory)).length !== 1) {
      throw new Error(`${label} did not preserve the uncleanable private stage for recovery.`);
    }
    await chmod(scenario.outputDirectory, 0o700);
    await chmod(retainedStage, 0o600);
    await rm(retainedStage);
    if ((await stages(scenario.outputDirectory)).length !== 0) throw new Error(`${label} harness cleanup failed.`);
  } finally {
    await restoreScenario(scenario);
  }
}

export async function runLinuxFilesystemFailureGate(): Promise<void> {
  if (process.platform !== 'linux') {
    console.log('Linux filesystem-failure evidence gate skipped: requires Linux.');
    return;
  }
  if (process.getuid?.() === 0) {
    console.log('Linux filesystem-failure evidence gate skipped: permission evidence requires a non-root user.');
    return;
  }
  await Promise.all([stat(cliEntry), stat(phaseGate), stat(stracePath), stat(bashPath)]);
  const parent = await mkdtemp(join(tmpdir(), 'local-pii-filesystem-failure-'));
  try {
    await runTargetCheckFailure(parent);
    await runStageCreateFailure(parent);
    await runFileLimitFailure(parent);
    await runReadFailure(parent, 'FIRST_STAGE_READ_BEFORE', 'stage-readback permission failure', 'The staged artifact could not be verified.');
    await runReadFailure(parent, 'SECOND_STAGE_READ_BEFORE', 'reopen permission failure', 'The input could not be read.');
    await runPublicationFailure(parent);
    await runCleanupFailure(parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
  console.log('Linux filesystem-failure evidence gate passed.');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    await runLinuxFilesystemFailureGate();
  } catch {
    // Child results are asserted in detail internally, but unexpected harness
    // failures must not put temporary paths or native errno text into CI logs.
    console.error('Linux filesystem-failure evidence gate failed.');
    process.exitCode = 1;
  }
}
