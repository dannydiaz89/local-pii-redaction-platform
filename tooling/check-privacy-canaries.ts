import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { executeCli, type CliIo } from '../apps/cli/src/commands.js';
import { scanPrivacyCanaries, type CanaryTarget } from './privacy-canaries.js';
import { createSyntheticCorpus, syntheticCorpusRoot } from './synthetic-corpus.js';

interface CapturedIo {
  readonly io: CliIo;
  readonly targets: () => readonly CanaryTarget[];
}

function capture(label: string): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    targets: () => [
      { name: `${label}:stdout`, content: stdout.join('') },
      { name: `${label}:stderr`, content: stderr.join('') }
    ]
  };
}

async function scanFiles(paths: readonly string[], canaries: readonly string[]): Promise<void> {
  const targets = await Promise.all(paths.map(async (path) => ({ name: path, content: await readFile(resolve(path), 'utf8') })));
  assertNoCanaries(canaries, targets);
}

function assertNoCanaries(canaries: readonly string[], targets: readonly CanaryTarget[]): void {
  const findings = scanPrivacyCanaries(canaries, targets);
  if (findings.length > 0) {
    const locations = findings.map(({ target, canaryIndex }) => `${target} (canary ${String(canaryIndex + 1)})`);
    throw new Error(`Synthetic privacy canary leaked into: ${locations.join(', ')}`);
  }
}

async function scanCurrentCliSurfaces(canaries: readonly string[]): Promise<void> {
  const document = createSyntheticCorpus().manifest.documents[0];
  const input = resolve(syntheticCorpusRoot, document.inputPath);
  const expected = resolve(syntheticCorpusRoot, document.expectedPath);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'local-pii-canary-'));
  const redacted = join(temporaryRoot, 'sample.redacted.txt');
  try {
    const commands = [
      { label: 'scan', argv: ['scan', input, '--json'], expectedExit: 0 },
      { label: 'redact', argv: ['redact', input, '--output', redacted, '--json'], expectedExit: 0 },
      { label: 'verify', argv: ['verify', expected, '--json'], expectedExit: 0 },
      { label: 'inspect', argv: ['inspect', input, '--json'], expectedExit: 0 }
    ] as const;
    const targets: CanaryTarget[] = [];
    for (const command of commands) {
      const captured = capture(command.label);
      const exitCode = await executeCli(command.argv, captured.io);
      if (exitCode !== command.expectedExit) throw new Error(`${command.label} exited ${String(exitCode)}`);
      targets.push(...captured.targets());
    }
    targets.push({ name: 'redacted-artifact', content: await readFile(redacted, 'utf8') });
    assertNoCanaries(canaries, targets);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const canaries = createSyntheticCorpus().canaryValues;
const explicitPaths = process.argv.slice(2).filter((argument) => argument !== '--');

const seededFinding = scanPrivacyCanaries(canaries, [{ name: 'scanner-self-test', content: canaries[0] ?? '' }]);
if (seededFinding.length !== 1) throw new Error('Privacy canary scanner did not detect a seeded leak');

if (explicitPaths.length > 0) await scanFiles(explicitPaths, canaries);
else await scanCurrentCliSurfaces(canaries);

console.log(`Privacy canary scan passed for ${String(canaries.length)} planted values.`);
