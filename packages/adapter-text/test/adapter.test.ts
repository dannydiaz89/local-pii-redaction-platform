import { mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseSha256Digest } from '@local-pii/domain';
import { compileTypedLabelPlan, type TypedLabelPlan } from '@local-pii/redaction';

import { rm } from 'node:fs/promises';

import {
  createLocalTextArtifactSession,
  createTextWriterReceipt,
  cleanupStaleTextStages,
  discardStagedTextArtifact,
  inventoryTextStages,
  readTextArtifact,
  writeTextArtifact,
  assertTextWriterReceiptIntegrity,
  type StagedTextArtifact,
  type TextArtifact
} from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'local-pii-adapter-'));
  directories.push(path);
  return path;
}

interface TestAction {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

function stageName(stem: string, uuid: string, extension = '.txt'): string {
  return `.${stem}.${uuid}.staged${extension}`;
}

async function makeStale(path: string): Promise<void> {
  const stale = new Date(Date.now() - 120_000);
  await utimes(path, stale, stale);
}

function typedLabelPlan(source: TextArtifact, actions: readonly TestAction[] = [{
  start: 0,
  end: Array.from(source.text).length,
  replacement: '[EMAIL_1]'
}]): TypedLabelPlan {
  return compileTypedLabelPlan({
    extractionRevision: source.extractionRevision,
    algorithmVersion: '0.1.0',
    digest: parseSha256Digest(`sha256:${'d'.repeat(64)}`),
    spans: actions.map((action, index) => {
      const suffix = String(index + 1).padStart(12, '0');
      const evidenceId = `00000000-0000-4000-8000-${suffix}`;
      return {
        id: `rsp_${evidenceId.replaceAll('-', '')}`,
        entityType: 'EMAIL' as const,
        start: action.start,
        end: action.end,
        confidence: 1,
        evidenceIds: [evidenceId]
      };
    }),
    conflicts: [],
    suppressedEvidenceIds: []
  }, {
    inputDigest: source.digest,
    capabilityDigest: parseSha256Digest(`sha256:${'c'.repeat(64)}`),
    detectorBundleVersion: 'test-detector',
    policy: {
      id: 'development-labels',
      version: '0.1.0',
      digest: parseSha256Digest(`sha256:${'e'.repeat(64)}`),
      riskTier: 'LOW'
    },
    writer: { id: 'text-adapter', version: '0.1.0' },
  });
}

describe('text adapter', () => {
  it('matches fixed SHA-256 vectors for artifact bytes and canonical extraction revisions', async () => {
    const root = await directory();
    const input = join(root, 'digest-vector.txt');
    await writeFile(input, 'abc');

    const artifact = await readTextArtifact(input);
    expect(artifact.digest).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(artifact.extractionRevision).toBe('sha256:71e62a5f6846cb7f4e417c5faec0ef86998e9be72c19b2dd93097bf3241f03d4');
  });

  it('preserves a UTF-8 BOM and never changes the input', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha@example.test')]);
    await writeFile(input, original);
    const artifact = await readTextArtifact(input);
    await writeTextArtifact(artifact, output, '[EMAIL_1]');
    expect(await readFile(input)).toEqual(original);
    expect(await readFile(output)).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[EMAIL_1]')]));
  });

  it('refuses output collisions and symbolic-link inputs', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    const link = join(root, 'link.txt');
    await writeFile(input, 'safe');
    await writeFile(output, 'existing');
    const artifact = await readTextArtifact(input);
    await expect(writeTextArtifact(artifact, output, 'replacement')).rejects.toMatchObject({ code: 'OUTPUT_COLLISION' });
    await symlink(input, link);
    await expect(readTextArtifact(link)).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
  });

  it('uses no staging or output files for input-only scan and verify flows', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    await writeFile(input, 'scan-only@example.test');

    const session = createLocalTextArtifactSession(input);
    expect(session.writer).toMatchObject({ id: 'text-adapter', version: '0.1.0' });
    expect(session.writer.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const artifact = await session.input();

    expect(artifact.text).toBe('scan-only@example.test');
    expect(await readdir(root)).toEqual(['input.txt']);
  });

  it('enforces a session-specific input limit before creating derived files', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    await writeFile(input, '12345');

    const session = createLocalTextArtifactSession(input, undefined, 4);

    await expect(session.input()).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
    expect(await readdir(root)).toEqual(['input.txt']);
  });

  it('stages restrictive bytes, reopens the exact staged artifact, and publishes without clobbering', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'redacted.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input, output);
    const plan = typedLabelPlan(await session.input());
    const staged = await session.stage(plan);
    expect((await stat(staged.path)).mode & 0o777).toBe(0o600);
    const reopened = await session.reopen(staged);
    expect(reopened.digest).toBe(staged.digest);
    expect(reopened.byteLength).toBe(staged.byteLength);
    expect(await readFile(staged.path, 'utf8')).toBe('[EMAIL_1]');
    expect(staged.receipt).toMatchObject({
      planDigest: plan.digest,
      writer: { id: 'text-adapter', version: '0.1.0' },
      expectedActionCount: 1,
      appliedActionIds: [plan.actions[0]?.id],
      appliedActionCount: 1,
      stagedDigest: staged.digest,
      stagedByteLength: staged.byteLength
    });
    expect(staged.receipt).not.toHaveProperty('path');
    expect(Object.keys(staged.receipt).sort()).toEqual([
      'appliedActionCount',
      'appliedActionIds',
      'expectedActionCount',
      'planDigest',
      'receiptDigest',
      'schemaVersion',
      'stagedByteLength',
      'stagedDigest',
      'writer'
    ]);
    assertTextWriterReceiptIntegrity(staged.receipt);

    await writeFile(output, 'must-not-be-replaced');
    await expect(session.publish(staged)).rejects.toMatchObject({ code: 'OUTPUT_COLLISION' });
    expect(await readFile(output, 'utf8')).toBe('must-not-be-replaced');
    await session.discard(staged);
  });

  it('applies multiple Unicode code-point actions in reverse without changing canonical receipt order', async () => {
    const root = await directory();
    const input = join(root, 'unicode.txt');
    const text = '😀 alpha@example.test و beta@example.test';
    await writeFile(input, text);
    const session = createLocalTextArtifactSession(input);
    const source = await session.input();
    const firstValue = 'alpha@example.test';
    const secondValue = 'beta@example.test';
    const firstStart = Array.from(text.slice(0, text.indexOf(firstValue))).length;
    const secondStart = Array.from(text.slice(0, text.indexOf(secondValue))).length;
    const plan = typedLabelPlan(source, [
      { start: firstStart, end: firstStart + Array.from(firstValue).length, replacement: '[EMAIL_1]' },
      { start: secondStart, end: secondStart + Array.from(secondValue).length, replacement: '[EMAIL_2]' }
    ]);

    const staged = await session.stage(plan);

    expect(await readFile(staged.path, 'utf8')).toBe('😀 [EMAIL_1] و [EMAIL_2]');
    expect(staged.receipt.appliedActionIds).toEqual(plan.actions.map(({ id }) => id));
    await session.discard(staged);
  });

  it('rejects publication when the source changes after staging', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'redacted.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input, output);
    const staged = await session.stage(typedLabelPlan(await session.input()));
    await writeFile(input, 'changed@example.test');

    await expect(session.publish(staged)).rejects.toMatchObject({ code: 'JOB_CONFLICT' });
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    await session.discard(staged);
  });

  it('rejects publication when receipted staged bytes change after verification', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'redacted.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input, output);
    const staged = await session.stage(typedLabelPlan(await session.input()));
    await writeFile(staged.path, 'tampered staged bytes');

    await expect(session.publish(staged)).rejects.toMatchObject({ code: 'ARTIFACT_DIGEST_MISMATCH' });
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    await session.discard(staged);
  });

  it('rejects reopening when staged bytes change before verification', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'redacted.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input, output);
    const staged = await session.stage(typedLabelPlan(await session.input()));
    await writeFile(staged.path, 'tampered before reopen');

    await expect(session.reopen(staged)).rejects.toMatchObject({
      code: 'ARTIFACT_DIGEST_MISMATCH', retryable: false
    });
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    await session.discard(staged);
  });

  it('publishes an absolute, storage-neutral reference for the CLI', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'redacted.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input, output);
    const staged = await session.stage(typedLabelPlan(await session.input()));

    const published = await session.publish(staged);

    expect(published).toMatchObject({ reference: output, digest: staged.digest, byteLength: staged.byteLength });
    expect(await readFile(output, 'utf8')).toBe('[EMAIL_1]');
  });

  it('honors cancellation at the final pre-publication checkpoint', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'redacted.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input, output);
    const staged = await session.stage(typedLabelPlan(await session.input()));
    let checks = 0;
    const signal = {
      get aborted(): boolean { return checks >= 5; },
      throwIfAborted(): void {
        checks += 1;
        if (checks >= 5) throw new DOMException('The operation was aborted.', 'AbortError');
      }
    } as unknown as AbortSignal;

    await expect(session.publish(staged, signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(staged.path, 'utf8')).toBe('[EMAIL_1]');
    await session.discard(staged);
  });

  it('reports success when cancellation races after the publication commit barrier', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'redacted.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input, output);
    const staged = await session.stage(typedLabelPlan(await session.input()));
    const controller = new AbortController();
    let checks = 0;
    const signal = {
      get aborted(): boolean { return controller.signal.aborted; },
      throwIfAborted(): void {
        checks += 1;
        if (checks === 5) queueMicrotask(() => { controller.abort(); });
        controller.signal.throwIfAborted();
      }
    } as unknown as AbortSignal;

    await expect(session.publish(staged, signal)).resolves.toMatchObject({ reference: output });
    expect(controller.signal.aborted).toBe(true);
    expect(await readFile(output, 'utf8')).toBe('[EMAIL_1]');
  });

  it('honors cancellation before staging without leaving a staged or published artifact', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'redacted.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input, output);
    const controller = new AbortController();
    controller.abort();

    await expect(session.stage(typedLabelPlan(await session.input()), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    expect(await readdir(root)).toEqual(['input.txt']);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('discards a candidate when cancellation is observed immediately after staging', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'redacted.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input, output);
    let checks = 0;
    const signal = {
      get aborted(): boolean { return checks >= 5; },
      throwIfAborted(): void {
        checks += 1;
        if (checks >= 5) throw new DOMException('The operation was aborted.', 'AbortError');
      }
    } as unknown as AbortSignal;

    await expect(session.stage(typedLabelPlan(await session.input()), signal)).rejects.toMatchObject({ name: 'AbortError' });

    expect(await readdir(root)).toEqual(['input.txt']);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('makes discard idempotent and signals unexpected cleanup failures safely', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input);
    const source = await session.input();
    const staged = await session.stage(typedLabelPlan(source));

    await session.discard(staged);
    await expect(session.discard(staged)).resolves.toBeUndefined();

    const directoryAtStagedPath = join(root, 'not-a-file.staged.txt');
    await mkdir(directoryAtStagedPath);
    const invalidStage: StagedTextArtifact = {
      reference: directoryAtStagedPath,
      path: directoryAtStagedPath,
      targetPath: join(root, 'out.txt'),
      byteLength: 0,
      digest: parseSha256Digest('sha256:0000000000000000000000000000000000000000000000000000000000000000'),
      receipt: createTextWriterReceipt(typedLabelPlan(source, []), {
        byteLength: 0,
        digest: parseSha256Digest('sha256:0000000000000000000000000000000000000000000000000000000000000000')
      })
    };
    await expect(discardStagedTextArtifact(invalidStage)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The staged artifact could not be removed.'
    });
  });

  it('inventories only stale, regular project stages and returns privacy-safe counts', async () => {
    const root = await directory();
    const uuid = '11111111-1111-4111-8111-111111111111';
    const staleStage = join(root, stageName('report', uuid));
    const freshStage = join(root, stageName('report', '22222222-2222-4222-8222-222222222222'));
    const protectedOutput = join(root, stageName('report', '33333333-3333-4333-8333-333333333333'));
    const symlinkStage = join(root, stageName('report', '44444444-4444-4444-8444-444444444444'));
    const directoryStage = join(root, stageName('report', '55555555-5555-4555-8555-555555555555'));
    const lookalike = join(root, '.report.not-a-uuid.staged.txt');
    const source = join(root, 'source.txt');
    await Promise.all([
      writeFile(staleStage, 'stale'),
      writeFile(freshStage, 'fresh'),
      writeFile(protectedOutput, 'requested output'),
      writeFile(lookalike, 'lookalike'),
      writeFile(source, 'source'),
      mkdir(directoryStage)
    ]);
    await symlink(source, symlinkStage);
    await Promise.all([makeStale(staleStage), makeStale(protectedOutput)]);

    const inventory = await inventoryTextStages({
      outputPath: join(root, 'report.txt'),
      minimumAgeMs: 60_000,
      protectedPaths: [source, protectedOutput]
    });

    expect(inventory).toEqual({
      scannedEntryCount: 7,
      matchingStageFileCount: 3,
      staleStageFileCount: 1,
      freshStageFileCount: 1,
      protectedEntryCount: 1,
      skippedUnsafeEntryCount: 2,
      capped: false
    });
    expect(await readFile(staleStage, 'utf8')).toBe('stale');
    expect(await readFile(freshStage, 'utf8')).toBe('fresh');
    expect(await readFile(protectedOutput, 'utf8')).toBe('requested output');
    expect(await readFile(symlinkStage, 'utf8')).toBe('source');
    expect((await stat(directoryStage)).isDirectory()).toBe(true);
    expect(await readFile(lookalike, 'utf8')).toBe('lookalike');
  });

  it('caps explicit stale-stage cleanup and is idempotent without deleting protected files', async () => {
    const root = await directory();
    const first = join(root, stageName('cleanup', '66666666-6666-4666-8666-666666666666'));
    const second = join(root, stageName('cleanup', '77777777-7777-4777-8777-777777777777'));
    const input = join(root, stageName('cleanup', '88888888-8888-4888-8888-888888888888'));
    await Promise.all([writeFile(first, 'first'), writeFile(second, 'second'), writeFile(input, 'input')]);
    await Promise.all([makeStale(first), makeStale(second), makeStale(input)]);

    const firstCleanup = await cleanupStaleTextStages({
      outputPath: join(root, 'cleanup.txt'),
      minimumAgeMs: 60_000,
      maximumDeletes: 1,
      protectedPaths: [input]
    });
    expect(firstCleanup).toMatchObject({
      staleStageFileCount: 2,
      protectedEntryCount: 1,
      deletedStageFileCount: 0,
      deletionFailureCount: 0,
      capped: true
    });
    expect((await readdir(root)).filter((name) => name.includes('.staged'))).toHaveLength(3);
    expect(await readFile(input, 'utf8')).toBe('input');

    const secondCleanup = await cleanupStaleTextStages({
      outputPath: join(root, 'cleanup.txt'),
      minimumAgeMs: 60_000,
      protectedPaths: [input]
    });
    expect(secondCleanup).toMatchObject({ deletedStageFileCount: 2, deletionFailureCount: 0, capped: false });
    const idempotentCleanup = await cleanupStaleTextStages({
      outputPath: join(root, 'cleanup.txt'),
      minimumAgeMs: 60_000,
      protectedPaths: [input]
    });
    expect(idempotentCleanup).toMatchObject({
      staleStageFileCount: 0,
      protectedEntryCount: 1,
      deletedStageFileCount: 0,
      deletionFailureCount: 0,
      capped: false
    });
    expect(await readFile(input, 'utf8')).toBe('input');
  });

  it('stops bounded enumeration and honors cancellation before deleting a stale stage', async () => {
    const root = await directory();
    const candidate = join(root, stageName('cleanup', '99999999-9999-4999-8999-999999999999'));
    await Promise.all([writeFile(candidate, 'stale'), writeFile(join(root, 'unrelated.txt'), 'unrelated')]);
    await makeStale(candidate);

    const bounded = await inventoryTextStages({
      outputPath: join(root, 'cleanup.txt'),
      minimumAgeMs: 60_000,
      maximumEntries: 1
    });
    expect(bounded).toMatchObject({ scannedEntryCount: 1, capped: true });
    const cappedCleanup = await cleanupStaleTextStages({
      outputPath: join(root, 'cleanup.txt'),
      minimumAgeMs: 60_000,
      maximumEntries: 1
    });
    expect(cappedCleanup).toMatchObject({ capped: true, deletedStageFileCount: 0 });
    expect(await readFile(candidate, 'utf8')).toBe('stale');
    await rm(join(root, 'unrelated.txt'));

    let checks = 0;
    const signal = {
      get aborted(): boolean { return checks >= 6; },
      throwIfAborted(): void {
        checks += 1;
        if (checks >= 6) throw new DOMException('The operation was aborted.', 'AbortError');
      }
    } as unknown as AbortSignal;
    await expect(cleanupStaleTextStages({
      outputPath: join(root, 'cleanup.txt'),
      minimumAgeMs: 60_000,
      signal
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readFile(candidate, 'utf8')).toBe('stale');
  });

  it('rejects plans that were bound to a different source, writer, or action count', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input);
    const source = await session.input();
    const plan = typedLabelPlan(source);

    await expect(session.stage({
      ...plan,
      inputDigest: parseSha256Digest(`sha256:${'b'.repeat(64)}`)
    })).rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });
    await expect(session.stage({
      ...plan,
      writer: { id: 'another-writer', version: '1.0.0' }
    })).rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });
    await expect(session.stage({ ...plan, expectedActionCount: 2 })).rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });

    expect(await readdir(root)).toEqual(['input.txt']);
  });

  it('rejects tampered or overlapping action plans and receipt mutations', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    await writeFile(input, 'alpha@example.test beta@example.test');
    const session = createLocalTextArtifactSession(input);
    const source = await session.input();
    const plan = typedLabelPlan(source, [
      { start: 0, end: 18, replacement: '[EMAIL_1]' },
      { start: 10, end: 20, replacement: '[EMAIL_2]' }
    ]);
    await expect(session.stage(plan)).rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });

    const staged = await session.stage(typedLabelPlan(source));
    expect(() => {
      assertTextWriterReceiptIntegrity({
        ...staged.receipt,
        appliedActionIds: []
      });
    }).toThrow('invalid');
    expect(() => {
      assertTextWriterReceiptIntegrity({
        ...staged.receipt,
        stagedByteLength: staged.receipt.stagedByteLength + 1
      });
    }).toThrow('digest');
    await session.discard(staged);
  });

  it('rejects a plan whose actions changed after its immutable digest was compiled', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input);
    const plan = typedLabelPlan(await session.input());
    const action = plan.actions[0];
    if (action === undefined) throw new Error('Expected one test action.');

    await expect(session.stage({
      ...plan,
      actions: [{ ...action, replacement: '[TAMPERED_1]' }]
    })).rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });
    expect(await readdir(root)).toEqual(['input.txt']);
  });
});
