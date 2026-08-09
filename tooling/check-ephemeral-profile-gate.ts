import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { createSyntheticCorpus } from './synthetic-corpus.js';

interface CapturedCommand {
  readonly label: string;
  readonly stdout: string;
  readonly stderr: string;
}

type FileSnapshot = ReadonlyMap<string, string>;

const repositoryRoot = resolve(import.meta.dirname, '..');
const cliEntry = resolve(repositoryRoot, 'apps/cli/dist/index.js');
const networkGuard = resolve(import.meta.dirname, 'ephemeral-profile-network-guard.cjs');
const networkGuardSelfTest = resolve(import.meta.dirname, 'ephemeral-profile-network-guard-self-test.mjs');

function fileDigest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function snapshotFiles(root: string, directory = root): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [nestedPath, digest] of await snapshotFiles(root, path)) snapshot.set(nestedPath, digest);
      continue;
    }
    const entryStat = await lstat(path);
    if (!entryStat.isFile()) throw new Error(`G1 workspace contains a non-regular entry: ${relative(root, path)}`);
    snapshot.set(relative(root, path), fileDigest(await readFile(path)));
  }
  return snapshot;
}

function assertWriteSet(
  label: string,
  before: FileSnapshot,
  after: FileSnapshot,
  expectedAdded: readonly string[]
): void {
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const changed = [...before.keys()].filter((path) => before.get(path) !== after.get(path)).sort();
  if (JSON.stringify(added) !== JSON.stringify([...expectedAdded].sort()) || removed.length > 0 || changed.length > 0) {
    throw new Error(
      `G1 ${label} write set was not ephemeral: added=${added.join(',') || 'none'} `
      + `removed=${removed.join(',') || 'none'} changed=${changed.join(',') || 'none'}`
    );
  }
}

async function runNode(args: readonly string[], cwd: string): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`G1 child process ended with signal ${signal}.`));
        return;
      }
      resolveResult({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

function permissionedNodeArguments(readPaths: readonly string[], writePath: string | undefined): string[] {
  const directoryPermission = (path: string): string => `${resolve(path)}/`;
  return [
    '--permission',
    ...readPaths.map((path) => `--allow-fs-read=${directoryPermission(path)}`),
    ...(writePath === undefined ? [] : [`--allow-fs-write=${directoryPermission(writePath)}`]),
    '--require', networkGuard
  ];
}

async function runBuiltCli(
  label: string,
  argv: readonly string[],
  root: string,
  writeDirectory: string | undefined,
  expectedExitCode: number,
  expectedAdded: readonly string[]
): Promise<CapturedCommand> {
  const before = await snapshotFiles(root);
  const canonicalRoot = await realpath(root);
  const result = await runNode([
    ...permissionedNodeArguments(
      [repositoryRoot, root, canonicalRoot],
      writeDirectory
    ),
    cliEntry,
    ...argv
  ], root);
  const after = await snapshotFiles(root);
  if (result.exitCode !== expectedExitCode) {
    throw new Error(`G1 ${label} exited ${String(result.exitCode)} instead of ${String(expectedExitCode)}: ${result.stderr}`);
  }
  assertWriteSet(label, before, after, expectedAdded);
  return { label, stdout: result.stdout, stderr: result.stderr };
}

function assertNoLeaks(captured: readonly CapturedCommand[], forbidden: readonly string[]): void {
  for (const command of captured) {
    const output = `${command.stdout}${command.stderr}`;
    for (const value of forbidden) {
      if (value.length > 0 && output.includes(value)) {
        throw new Error(`G1 ${command.label} captured source, report, or path leakage.`);
      }
    }
  }
}

function capturedJson(captured: readonly CapturedCommand[], label: string): Record<string, unknown> {
  const command = captured.find((entry) => entry.label === label);
  if (command === undefined) throw new Error(`G1 did not capture ${label}.`);
  return JSON.parse(command.stdout) as Record<string, unknown>;
}

async function assertNetworkGuard(): Promise<void> {
  const result = await runNode([
    ...permissionedNodeArguments([repositoryRoot], undefined),
    networkGuardSelfTest
  ], repositoryRoot);
  if (result.exitCode !== 0 || !result.stdout.includes('G1 network guard self-test passed.')) {
    throw new Error(`G1 network guard self-test failed: ${result.stderr}`);
  }
  const suppressedAttempt = await runNode([
    ...permissionedNodeArguments([repositoryRoot], undefined),
    '--input-type=module',
    '--eval',
    "await fetch('https://example.invalid/').catch(() => undefined);"
  ], repositoryRoot);
  if (
    suppressedAttempt.exitCode !== 97
    || !suppressedAttempt.stderr.includes('G1 network guard observed a forbidden network attempt.')
  ) {
    throw new Error('G1 network guard did not fail a process that suppressed a forbidden attempt.');
  }
}

async function assertFixtureReadPermission(root: string, source: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const result = await runNode([
    ...permissionedNodeArguments([repositoryRoot, root, canonicalRoot], undefined),
    '--input-type=module',
    '--eval',
    "await (await import('node:fs/promises')).readFile(process.argv[1]);",
    source
  ], root);
  if (result.exitCode !== 0) throw new Error(`G1 fixture read permission failed: ${result.stderr}`);
}

/**
 * Runs the built default CLI under Node's permission model in an empty
 * workspace. Read-only commands receive no filesystem write permission;
 * redaction receives write permission only for its dedicated output fixture.
 */
export async function runEphemeralProfileGate(): Promise<void> {
  await stat(cliEntry);
  await assertNetworkGuard();

  const corpus = createSyntheticCorpus();
  const root = await mkdtemp(join(tmpdir(), 'local-pii-g1-'));
  const fixtureDirectory = join(root, 'fixtures');
  const writeDirectory = join(root, 'published');
  const sourceName = 'fixtures/source.txt';
  const expectedName = 'fixtures/verified-redacted.txt';
  const outputName = 'published/explicit-verified-output.txt';
  const source = join(root, sourceName);
  const expected = join(root, expectedName);
  const output = join(root, outputName);

  try {
    await Promise.all([mkdir(fixtureDirectory), mkdir(writeDirectory)]);
    await Promise.all([
      writeFile(source, corpus.input, 'utf8'),
      writeFile(expected, corpus.expected, 'utf8')
    ]);
    await assertFixtureReadPermission(root, source);
    const initialSnapshot = await snapshotFiles(root);
    const captured = [
      await runBuiltCli('inspect', ['inspect', source, '--json'], root, undefined, 0, []),
      await runBuiltCli('scan', ['scan', source, '--json'], root, undefined, 0, []),
      await runBuiltCli('verify', ['verify', expected, '--json'], root, undefined, 0, []),
      await runBuiltCli('verify failure', ['verify', source, '--json'], root, undefined, 4, []),
      await runBuiltCli('capabilities', ['capabilities', '--json'], root, undefined, 0, []),
      await runBuiltCli('policy list', ['policies', 'list', '--json'], root, undefined, 0, []),
      await runBuiltCli('policy explain', ['policies', 'explain', 'development-labels', '--json'], root, undefined, 0, []),
      await runBuiltCli('cleanup dry-run', ['cleanup-stages', '--output', output, '--json'], root, undefined, 0, []),
      await runBuiltCli('redact without output', ['redact', source, '--json'], root, undefined, 2, []),
      await runBuiltCli('redact', ['redact', source, '--output', output, '--json'], root, writeDirectory, 0, [outputName]),
      await runBuiltCli('redact collision', ['redact', source, '--output', output, '--json'], root, writeDirectory, 6, [])
    ];

    const finalSnapshot = await snapshotFiles(root);
    const expectedFiles = [sourceName, expectedName, outputName].sort();
    if (JSON.stringify([...finalSnapshot.keys()].sort()) !== JSON.stringify(expectedFiles)) {
      throw new Error('G1 workspace retained a source, report, or staging file outside the explicit output.');
    }
    for (const path of [sourceName, expectedName]) {
      if (finalSnapshot.get(path) !== initialSnapshot.get(path)) {
        throw new Error(`G1 mutated the input fixture ${path}.`);
      }
    }
    const redacted = await readFile(output, 'utf8');
    if (redacted !== corpus.expected) throw new Error('G1 redaction did not publish the expected verified artifact.');
    const capabilities = capturedJson(captured, 'capabilities');
    if (capabilities.engineMode !== 'RULES_ONLY') throw new Error('G1 default capabilities were not rules-only.');
    const policyList = capturedJson(captured, 'policy list');
    if (policyList.operation !== 'POLICY_LIST') throw new Error('G1 policy list did not return its canonical report.');
    const policyExplain = capturedJson(captured, 'policy explain');
    if (policyExplain.satisfiable !== true) throw new Error('G1 development policy was unexpectedly unsatisfiable.');
    const failedVerification = capturedJson(captured, 'verify failure');
    if (failedVerification.outcome !== 'FAIL') throw new Error('G1 unredacted input did not fail verification.');
    const cleanup = capturedJson(captured, 'cleanup dry-run');
    if (cleanup.mode !== 'DRY_RUN') throw new Error('G1 cleanup was not a dry-run.');
    const redactReport = capturedJson(captured, 'redact') as { readonly outcome?: string; readonly verification?: { readonly outcome?: string } };
    if (redactReport.outcome !== 'VERIFIED' || redactReport.verification?.outcome !== 'PASS') {
      throw new Error('G1 redaction output was not attested as verified.');
    }
    assertNoLeaks(captured, [
      corpus.input,
      corpus.expected,
      ...corpus.canaryValues,
      root,
      source,
      expected,
      output
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await runEphemeralProfileGate();
console.log('G1 ephemeral-profile gate passed.');
