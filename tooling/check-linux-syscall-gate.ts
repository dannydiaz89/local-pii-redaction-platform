import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { createSyntheticCorpus } from './synthetic-corpus.js';

type TraceKind = 'file' | 'network';

interface CapturedCommand {
  readonly label: string;
  readonly argv: readonly string[];
  readonly expectedExitCode: number;
  readonly expectedAdded: readonly string[];
}

interface Workspace {
  readonly root: string;
  readonly fixtureDirectory: string;
  readonly outputDirectory: string;
  readonly source: string;
  readonly expected: string;
  readonly output: string;
  readonly sourceName: string;
  readonly expectedName: string;
  readonly outputName: string;
}

interface TracedCommand {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

type FileSnapshot = ReadonlyMap<string, string>;
type MutationKind = 'STAGE_CREATE' | 'PUBLISH_LINK' | 'STAGE_CLEANUP' | 'UNEXPECTED';

const repositoryRoot = resolve(import.meta.dirname, '..');
const cliEntry = resolve(repositoryRoot, 'apps/cli/dist/index.js');
const stracePath = '/usr/bin/strace';
const commandTimeoutMs = 15_000;

function digest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function snapshotFiles(root: string, directory = root): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [nestedPath, fileDigest] of await snapshotFiles(root, path)) snapshot.set(nestedPath, fileDigest);
      continue;
    }
    if (!entry.isFile()) throw new Error('Linux syscall evidence workspace contained a non-regular entry.');
    const metadata = await lstat(path, { bigint: true });
    snapshot.set(relative(root, path), [
      digest(await readFile(path)),
      metadata.mode.toString(),
      metadata.uid.toString(),
      metadata.gid.toString(),
      metadata.size.toString(),
      metadata.mtimeNs.toString(),
      metadata.ctimeNs.toString()
    ].join(':'));
  }
  return snapshot;
}

function assertWriteSet(label: string, before: FileSnapshot, after: FileSnapshot, expectedAdded: readonly string[]): void {
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const changed = [...before.keys()].filter((path) => before.get(path) !== after.get(path)).sort();
  if (JSON.stringify(added) !== JSON.stringify([...expectedAdded].sort()) || removed.length > 0 || changed.length > 0) {
    throw new Error(`Linux syscall evidence ${label} changed an unexpected workspace artifact.`);
  }
}

async function createWorkspace(root: string): Promise<Workspace> {
  const workspaceRoot = await mkdtemp(join(root, 'workspace-'));
  const fixtureDirectory = join(workspaceRoot, 'fixtures');
  const outputDirectory = join(workspaceRoot, 'published');
  const sourceName = 'fixtures/source.txt';
  const expectedName = 'fixtures/verified-redacted.txt';
  const outputName = 'published/explicit-verified-output.txt';
  const source = join(workspaceRoot, sourceName);
  const expected = join(workspaceRoot, expectedName);
  const output = join(workspaceRoot, outputName);
  const corpus = createSyntheticCorpus();
  await Promise.all([mkdir(fixtureDirectory), mkdir(outputDirectory)]);
  await Promise.all([writeFile(source, corpus.input, 'utf8'), writeFile(expected, corpus.expected, 'utf8')]);
  return { root: workspaceRoot, fixtureDirectory, outputDirectory, source, expected, output, sourceName, expectedName, outputName };
}

function commandMatrix(workspace: Workspace): readonly CapturedCommand[] {
  return [
    { label: 'inspect', argv: ['inspect', workspace.source, '--json'], expectedExitCode: 0, expectedAdded: [] },
    { label: 'scan', argv: ['scan', workspace.source, '--json'], expectedExitCode: 0, expectedAdded: [] },
    { label: 'verify', argv: ['verify', workspace.expected, '--json'], expectedExitCode: 0, expectedAdded: [] },
    { label: 'verify failure', argv: ['verify', workspace.source, '--json'], expectedExitCode: 4, expectedAdded: [] },
    { label: 'capabilities', argv: ['capabilities', '--json'], expectedExitCode: 0, expectedAdded: [] },
    { label: 'policy list', argv: ['policies', 'list', '--json'], expectedExitCode: 0, expectedAdded: [] },
    { label: 'policy explain', argv: ['policies', 'explain', 'development-labels', '--json'], expectedExitCode: 0, expectedAdded: [] },
    { label: 'cleanup dry-run', argv: ['cleanup-stages', '--output', workspace.output, '--json'], expectedExitCode: 0, expectedAdded: [] },
    { label: 'redact without output', argv: ['redact', workspace.source, '--json'], expectedExitCode: 2, expectedAdded: [] },
    { label: 'redact', argv: ['redact', workspace.source, '--output', workspace.output, '--json'], expectedExitCode: 0, expectedAdded: [workspace.outputName] },
    { label: 'redact collision', argv: ['redact', workspace.source, '--output', workspace.output, '--json'], expectedExitCode: 6, expectedAdded: [] }
  ];
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined || child.pid <= 0) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function runTraced(
  traceDirectory: string,
  traceKind: TraceKind,
  commandIndex: number,
  workspace: Workspace,
  command: CapturedCommand
): Promise<TracedCommand> {
  const prefix = join(traceDirectory, `${traceKind}-${String(commandIndex).padStart(2, '0')}`);
  return await new Promise((resolveResult, reject) => {
    const traceExpression = traceKind === 'file'
      ? 'trace=%file,fchmod,fchown,ftruncate,fallocate,fsetxattr,fremovexattr'
      : 'trace=%network';
    const child = spawn(stracePath, [
      '-ff', '-qq', '-s', traceKind === 'network' ? '1' : '4096', '-o', prefix,
      '-e', traceExpression,
      process.execPath, cliEntry, ...command.argv
    ], {
      cwd: workspace.root,
      env: { ...process.env, NODE_OPTIONS: undefined },
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    let settled = false;
    let timedOut = false;
    let shutdownTimeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (shutdownTimeout !== undefined) clearTimeout(shutdownTimeout);
      callback();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        killProcessTree(child);
      } catch {
        // The original timeout result is clearer and does not disclose paths.
      }
      shutdownTimeout = setTimeout(() => {
        finish(() => {
          reject(new Error(`Linux syscall evidence ${command.label} did not stop after its bounded runtime.`));
        });
      }, 2_000);
    }, commandTimeoutMs);
    child.once('error', (error) => {
      finish(() => {
        reject(error instanceof Error ? error : new Error('Linux syscall evidence tracer failed.'));
      });
    });
    child.once('close', (exitCode, signal) => {
      if (timedOut) {
        finish(() => {
          reject(new Error(`Linux syscall evidence ${command.label} exceeded its bounded runtime.`));
        });
        return;
      }
      void (async () => {
      try {
        const traceNames = (await readdir(traceDirectory))
          .filter((name) => name.startsWith(`${traceKind}-${String(commandIndex).padStart(2, '0')}.`))
          .sort();
        if (traceNames.length === 0) {
          throw new Error(`Linux syscall evidence ${command.label} produced no trace evidence.`);
        }
        const lines = (await Promise.all(traceNames.map(async (name) =>
          (await readFile(join(traceDirectory, name), 'utf8')).split('\n').filter((line) => line.length > 0)
        ))).flat();
        finish(() => {
          if (signal !== null) {
            reject(new Error(`Linux syscall evidence ${command.label} ended from a signal.`));
            return;
          }
          resolveResult({ exitCode: exitCode ?? 1, lines });
        });
      } catch (error: unknown) {
        finish(() => {
          reject(error instanceof Error ? error : new Error('Linux syscall evidence trace could not be read.'));
        });
      }
      })();
    });
  });
}

function quotedPaths(line: string): readonly string[] {
  return [...line.matchAll(/"((?:\\.|[^"\\])*)"/gu)].map((match) => match[1] ?? '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function stagePathPattern(output: string): RegExp {
  const extension = output.slice(output.lastIndexOf('.'));
  const stem = basename(output, extension);
  const parent = resolve(output, '..');
  return new RegExp(
    `^${escapeRegex(parent)}/\\.${escapeRegex(stem)}\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.staged${escapeRegex(extension)}$`,
    'u'
  );
}

export function syscallMutations(
  lines: readonly string[],
  workspace: Readonly<Pick<Workspace, 'output'>>
): readonly MutationKind[] {
  const stagePattern = stagePathPattern(workspace.output);
  const result: MutationKind[] = [];
  const additionalMutators = new Set([
    'rename', 'renameat', 'renameat2', 'mkdir', 'mkdirat', 'rmdir', 'symlink', 'symlinkat', 'mknod', 'mknodat',
    'chmod', 'fchmod', 'fchmodat', 'fchmodat2', 'chown', 'fchown', 'lchown', 'fchownat', 'truncate', 'ftruncate',
    'utime', 'utimes', 'futimesat', 'utimensat', 'setxattr', 'lsetxattr', 'fsetxattr', 'removexattr',
    'lremovexattr', 'fremovexattr', 'fallocate', 'mount', 'umount2', 'pivot_root'
  ]);
  for (const line of lines) {
    const operation = line.match(/^([a-z0-9_]+)\(/u)?.[1];
    const paths = quotedPaths(line);
    const firstPath = paths[0];
    if (operation === 'creat') {
      result.push('UNEXPECTED');
      continue;
    }
    if (operation === 'open' || operation === 'openat' || operation === 'openat2') {
      if (!/O_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND|TMPFILE)/u.test(line)) continue;
      const isRestrictiveStageCreate = firstPath !== undefined
        && stagePattern.test(firstPath)
        && /O_WRONLY/u.test(line)
        && /O_CREAT/u.test(line)
        && /O_EXCL/u.test(line)
        && !/O_(?:RDWR|TRUNC|APPEND|TMPFILE)/u.test(line)
        && /,\s*0600\)\s*=/u.test(line);
      result.push(isRestrictiveStageCreate ? 'STAGE_CREATE' : 'UNEXPECTED');
      continue;
    }
    if (operation === 'link' || operation === 'linkat') {
      result.push(paths.length >= 2 && stagePattern.test(paths[0] ?? '') && paths[1] === workspace.output ? 'PUBLISH_LINK' : 'UNEXPECTED');
      continue;
    }
    if (operation === 'unlink' || operation === 'unlinkat') {
      result.push(firstPath !== undefined && stagePattern.test(firstPath) ? 'STAGE_CLEANUP' : 'UNEXPECTED');
      continue;
    }
    if (operation !== undefined && additionalMutators.has(operation)) result.push('UNEXPECTED');
  }
  return result;
}

async function runFileEvidence(root: string): Promise<void> {
  const workspace = await createWorkspace(root);
  const traceDirectory = join(root, 'file-traces');
  await mkdir(traceDirectory);
  try {
    for (const [index, command] of commandMatrix(workspace).entries()) {
      const before = await snapshotFiles(workspace.root);
      const traced = await runTraced(traceDirectory, 'file', index, workspace, command);
      const after = await snapshotFiles(workspace.root);
      if (traced.exitCode !== command.expectedExitCode) {
        throw new Error(`Linux syscall evidence ${command.label} returned an unexpected exit status.`);
      }
      assertWriteSet(command.label, before, after, command.expectedAdded);
      const observed = syscallMutations(traced.lines, workspace);
      const expected = command.label === 'redact'
        ? ['STAGE_CREATE', 'PUBLISH_LINK', 'STAGE_CLEANUP']
        : [];
      if (JSON.stringify(observed) !== JSON.stringify(expected)) {
        throw new Error(`Linux syscall evidence ${command.label} observed an unexpected filesystem mutation sequence.`);
      }
    }
  } finally {
    await rm(traceDirectory, { recursive: true, force: true });
    await rm(workspace.root, { recursive: true, force: true });
  }
}

async function runNetworkEvidence(root: string): Promise<void> {
  const workspace = await createWorkspace(root);
  const traceDirectory = join(root, 'network-traces');
  await mkdir(traceDirectory);
  try {
    for (const [index, command] of commandMatrix(workspace).entries()) {
      const traced = await runTraced(traceDirectory, 'network', index, workspace, command);
      if (traced.exitCode !== command.expectedExitCode) {
        throw new Error(`Linux syscall evidence ${command.label} returned an unexpected exit status.`);
      }
      if (traced.lines.length > 0) {
        throw new Error(`Linux syscall evidence ${command.label} observed a network syscall.`);
      }
    }
  } finally {
    await rm(traceDirectory, { recursive: true, force: true });
    await rm(workspace.root, { recursive: true, force: true });
  }
}

export async function runLinuxSyscallGate(): Promise<void> {
  if (process.platform !== 'linux') {
    console.log('Linux syscall evidence gate skipped: requires Linux and strace.');
    return;
  }
  try {
    await access(stracePath);
  } catch {
    throw new Error('Linux syscall evidence gate requires /usr/bin/strace.');
  }
  await stat(cliEntry);
  const root = await mkdtemp(join(tmpdir(), 'local-pii-strace-'));
  try {
    // The filesystem profile is deliberately raw Node: the permission/network
    // preload behavior is asserted separately by the application-level G1 gate.
    await runFileEvidence(root);
    // Do not preload the JavaScript network guard here: this is direct kernel
    // evidence that the default CLI itself makes no network system calls.
    await runNetworkEvidence(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log('Linux syscall evidence gate passed.');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await runLinuxSyscallGate();
}
