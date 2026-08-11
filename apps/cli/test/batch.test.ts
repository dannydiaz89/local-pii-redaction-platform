import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { deterministicDetectorBundleVersion } from '@local-pii/detectors';
import { batchScanReportSchemaId, batchScanReportV2SchemaId, validateContract } from '@local-pii/contracts';
import { SafeError } from '@local-pii/domain';

import { assertBatchFileUnchanged, discoverBatchFiles, matchesBatchPattern } from '../src/batch.js';
import { mustAbortBatchRedaction } from '../src/batch-redact.js';
import { executeCli, type CliIo } from '../src/commands.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix = 'local-pii-batch-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function capture(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) }
  };
}

async function relativeInventory(root: string): Promise<readonly string[]> {
  const inventory: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      inventory.push(relative);
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
    }
  };
  await visit(root, '');
  return inventory.sort();
}

describe('bounded batch scan', () => {
  it('matches bounded Unicode globs without regular-expression backtracking', () => {
    expect(matchesBatchPattern('**/*.txt', 'root.txt')).toBe(true);
    expect(matchesBatchPattern('**/*.txt', 'nested/root.txt')).toBe(true);
    expect(matchesBatchPattern('**/foo.txt', 'xfoo.txt')).toBe(false);
    expect(matchesBatchPattern('a/**/b.txt', 'a/xxb.txt')).toBe(false);
    expect(matchesBatchPattern('a/**/b.txt', 'a/x/b.txt')).toBe(true);
    expect(matchesBatchPattern('nested/?.txt', 'nested/😀.txt')).toBe(true);
    expect(matchesBatchPattern('*a*a*a*a*a*a*b', 'a'.repeat(80))).toBe(false);
  });

  it('recursively applies include/exclude rules and emits only an aggregate privacy-safe manifest', async () => {
    const root = await temporaryRoot('private-root-canary-');
    const nested = join(root, 'nested-private-name');
    await mkdir(nested);
    await writeFile(join(root, 'included-private-name.txt'), 'Contact alpha@example.test');
    await writeFile(join(nested, 'excluded-private-name.txt'), 'private-value-canary@example.test');
    await writeFile(join(root, 'ignored-private-name.bin'), 'ignored-value-canary@example.test');
    const before = await relativeInventory(root);
    const stream = capture();

    expect(await executeCli([
      'batch', 'scan', root,
      '--include', '**/*.txt',
      '--exclude', '**/excluded-*',
      '--json'
    ], stream.io)).toBe(0);

    const output = stream.stdout.join('');
    const report = JSON.parse(output) as {
      readonly operation: string;
      readonly outcome: string;
      readonly manifest: {
        readonly selectedFileCount: number;
        readonly processedFileCount: number;
        readonly detectionCount: number;
        readonly conflictCount: number;
      };
    };
    expect(report).toMatchObject({
      operation: 'BATCH_SCAN',
      outcome: 'SUCCEEDED',
      completionPolicy: 'REQUIRE_COMPLETE',
      manifest: { selectedFileCount: 1, processedFileCount: 1, detectionCount: 1, conflictCount: 0 }
    });
    expect(stream.stderr).toEqual([]);
    expect(output).not.toContain(root);
    expect(output).not.toContain('included-private-name');
    expect(output).not.toContain('excluded-private-name');
    expect(output).not.toContain('alpha@example.test');
    expect(output).not.toContain('private-value-canary');
    expect(await relativeInventory(root)).toEqual(before);
  });

  it('rejects symbolic links without reporting their target, name, or contents', async () => {
    const root = await temporaryRoot();
    const external = await temporaryRoot('external-private-root-');
    const target = join(external, 'private-target-name.txt');
    await writeFile(target, 'private-target-value@example.test');
    await symlink(target, join(root, 'private-link-name.txt'));
    const stream = capture();

    expect(await executeCli(['batch', 'scan', root, '--json'], stream.io)).toBe(3);

    const output = stream.stderr.join('');
    expect(JSON.parse(output)).toMatchObject({ error: { code: 'FORMAT_UNSUPPORTED' } });
    expect(output).not.toContain(root);
    expect(output).not.toContain(external);
    expect(output).not.toContain('private-link-name');
    expect(output).not.toContain('private-target-value');
  });

  it('reports the configured detector bundle for an empty matched selection', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'ignored.bin'), 'synthetic');
    const stream = capture();

    expect(await executeCli(['batch', 'scan', root, '--json'], stream.io)).toBe(0);

    expect(JSON.parse(stream.stdout.join(''))).toMatchObject({
      outcome: 'SUCCEEDED',
      detectorBundleVersion: deterministicDetectorBundleVersion,
      manifest: {
        complete: true,
        selectedFileCount: 0,
        processedFileCount: 0,
        failedFileCount: 0
      }
    });
  });

  it('fails before processing when a traversal bound is exceeded', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'one.txt'), 'one');
    await writeFile(join(root, 'two.txt'), 'two');

    await expect(discoverBatchFiles(root, {
      includes: ['**/*.txt'],
      excludes: [],
      limits: {
        maximumFiles: 1,
        maximumDirectories: 2,
        maximumEntries: 10,
        maximumTotalInputBytes: 100
      }
    })).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
      message: 'The batch input exceeds the bounded traversal or byte limits.'
    });
  });

  it('rejects a queued directory replaced by a symbolic link before reading it', async () => {
    const root = await temporaryRoot();
    const nested = join(root, 'nested');
    const external = await temporaryRoot('external-private-directory-');
    await mkdir(nested);
    await writeFile(join(external, 'private-target.txt'), 'private-target@example.test');
    let replaced = false;

    await expect(discoverBatchFiles(root, {
      includes: ['**/*.txt'],
      excludes: [],
      async beforeDirectoryRead(directoryPath, relativePath) {
        if (relativePath !== 'nested' || replaced) return;
        replaced = true;
        await rm(directoryPath, { recursive: true });
        await symlink(external, directoryPath, 'dir');
      }
    })).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
  });

  it('detects a selected file changed after discovery', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'selected.txt');
    await writeFile(path, 'first');
    const traversal = await discoverBatchFiles(root, { includes: ['**/*.txt'], excludes: [] });
    const file = traversal.files[0];
    if (file === undefined) throw new Error('Synthetic batch file was not discovered.');
    await writeFile(path, 'second value');

    await expect(assertBatchFileUnchanged(file)).rejects.toMatchObject({ code: 'JOB_CONFLICT' });
  });

  it('preserves completed aggregate evidence when one selected file fails safely', async () => {
    const root = await temporaryRoot('partial-private-root-');
    await writeFile(join(root, 'valid-private-name.txt'), 'Contact alpha@example.test');
    await writeFile(join(root, 'invalid-private-name.json'), '{"private-value-canary":');
    const stream = capture();

    expect(await executeCli(['batch', 'scan', root, '--json'], stream.io)).toBe(3);

    const output = stream.stdout.join('');
    expect(JSON.parse(output)).toMatchObject({
      operation: 'BATCH_SCAN',
      outcome: 'PARTIAL',
      completionPolicy: 'REQUIRE_COMPLETE',
      manifest: {
        complete: false,
        selectedFileCount: 2,
        processedFileCount: 1,
        failedFileCount: 1,
        detectionCount: 1,
        failuresByCode: { FORMAT_CORRUPT: 1 }
      }
    });
    expect(stream.stderr).toEqual([]);
    expect(output).not.toContain(root);
    expect(output).not.toContain('valid-private-name');
    expect(output).not.toContain('invalid-private-name');
    expect(output).not.toContain('alpha@example.test');
    expect(output).not.toContain('private-value-canary');
  });

  it('allows an explicit partial-success policy without hiding the partial outcome', async () => {
    const root = await temporaryRoot('allowed-partial-private-root-');
    await writeFile(join(root, 'valid-private-name.txt'), 'Contact alpha@example.test');
    await writeFile(join(root, 'invalid-private-name.json'), '{"private-value-canary":');
    const stream = capture();

    expect(await executeCli(['batch', 'scan', root, '--allow-partial', '--json'], stream.io)).toBe(0);

    const output = stream.stdout.join('');
    expect(JSON.parse(output)).toMatchObject({
      operation: 'BATCH_SCAN',
      outcome: 'PARTIAL',
      completionPolicy: 'ALLOW_PARTIAL',
      manifest: {
        complete: false,
        selectedFileCount: 2,
        processedFileCount: 1,
        failedFileCount: 1,
        failuresByCode: { FORMAT_CORRUPT: 1 }
      }
    });
    expect(stream.stderr).toEqual([]);
    expect(output).not.toContain(root);
    expect(output).not.toContain('valid-private-name');
    expect(output).not.toContain('invalid-private-name');
    expect(output).not.toContain('alpha@example.test');
    expect(output).not.toContain('private-value-canary');
  });

  it('does not convert an all-failed batch into success when partial success is allowed', async () => {
    const root = await temporaryRoot('failed-partial-private-root-');
    await writeFile(join(root, 'invalid-private-name.json'), '{"private-value-canary":');
    const stream = capture();

    expect(await executeCli(['batch', 'scan', root, '--allow-partial', '--json'], stream.io)).toBe(3);

    const output = stream.stdout.join('');
    expect(JSON.parse(output)).toMatchObject({
      operation: 'BATCH_SCAN',
      outcome: 'FAILED',
      completionPolicy: 'ALLOW_PARTIAL',
      manifest: {
        complete: false,
        selectedFileCount: 1,
        processedFileCount: 0,
        failedFileCount: 1,
        failuresByCode: { FORMAT_CORRUPT: 1 }
      }
    });
    expect(stream.stderr).toEqual([]);
    expect(output).not.toContain(root);
    expect(output).not.toContain('invalid-private-name');
    expect(output).not.toContain('private-value-canary');
  });

  it('rejects the partial-success option outside batch scan', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'selected.txt');
    await writeFile(path, 'synthetic');
    const stream = capture();

    expect(await executeCli(['scan', path, '--allow-partial', '--json'], stream.io)).toBe(2);
    expect(JSON.parse(stream.stderr.join(''))).toMatchObject({ error: { code: 'SCHEMA_INVALID' } });
  });

  it('rejects unsafe patterns as command usage errors', async () => {
    const root = await temporaryRoot();
    const stream = capture();

    expect(await executeCli(['batch', 'scan', root, '--include', '../*.txt', '--json'], stream.io)).toBe(2);
    expect(JSON.parse(stream.stderr.join(''))).toMatchObject({ error: { code: 'SCHEMA_INVALID' } });
  });

  it('honors cooperative cancellation during traversal', async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    controller.abort();

    await expect(discoverBatchFiles(root, {
      includes: ['**/*.txt'],
      excludes: [],
      signal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects contradictory aggregate manifests after schema validation', () => {
    const base = {
      schemaVersion: '1.0.0',
      operation: 'BATCH_SCAN',
      outcome: 'SUCCEEDED',
      detectorBundleVersion: deterministicDetectorBundleVersion,
      manifest: {
        complete: true,
        selectedFileCount: 1,
        processedFileCount: 1,
        failedFileCount: 0,
        directoryCount: 1,
        entryCount: 1,
        totalInputBytes: 10,
        processedInputBytes: 10,
        detectionCount: 1,
        conflictCount: 0,
        byEntity: { EMAIL: 1 },
        failuresByCode: {}
      },
      selection: { includePatternCount: 1, excludePatternCount: 0 },
      limits: {
        maximumFiles: 1000,
        maximumDirectories: 1000,
        maximumEntries: 10000,
        maximumTotalInputBytes: 268435456,
        maximumRelativePathCodeUnits: 8192,
        maximumPatternMatchSteps: 100000000,
        timeoutMs: 60000
      }
    } as const;
    expect(validateContract(batchScanReportSchemaId, base).valid).toBe(true);
    expect(validateContract(batchScanReportSchemaId, {
      ...base,
      completionPolicy: 'IGNORE_FAILURES'
    }).valid).toBe(false);
    const v2Base = {
      ...base,
      schemaVersion: '2.0.0',
      completionPolicy: 'REQUIRE_COMPLETE'
    } as const;
    expect(validateContract(batchScanReportV2SchemaId, v2Base).valid).toBe(true);
    expect(validateContract(batchScanReportV2SchemaId, {
      ...v2Base,
      manifest: { ...v2Base.manifest, processedInputBytes: 11 }
    }).valid).toBe(false);
    expect(validateContract(batchScanReportSchemaId, {
      ...base,
      manifest: { ...base.manifest, selectedFileCount: 0 }
    }).valid).toBe(false);
    expect(validateContract(batchScanReportSchemaId, {
      ...base,
      manifest: { ...base.manifest, processedInputBytes: 11 }
    }).valid).toBe(false);
    expect(validateContract(batchScanReportSchemaId, {
      ...base,
      manifest: { ...base.manifest, detectionCount: 2 }
    }).valid).toBe(false);
    expect(validateContract(batchScanReportSchemaId, {
      ...base,
      outcome: 'PARTIAL',
      manifest: {
        ...base.manifest,
        complete: false,
        selectedFileCount: 2,
        failedFileCount: 1,
        failuresByCode: { FORMAT_CORRUPT: 2 }
      }
    }).valid).toBe(false);
    const emptyManifest = {
      ...base.manifest,
      selectedFileCount: 0,
      processedFileCount: 0,
      totalInputBytes: 0,
      processedInputBytes: 0,
      detectionCount: 0,
      byEntity: {}
    };
    expect(validateContract(batchScanReportSchemaId, {
      ...base,
      manifest: emptyManifest
    }).valid).toBe(true);
    expect(validateContract(batchScanReportSchemaId, {
      ...base,
      manifest: { ...emptyManifest, totalInputBytes: 1 }
    }).valid).toBe(false);
    expect(validateContract(batchScanReportSchemaId, {
      ...base,
      manifest: { ...emptyManifest, processedInputBytes: 1 }
    }).valid).toBe(false);
    expect(validateContract(batchScanReportSchemaId, {
      ...base,
      outcome: 'NEEDS_REVIEW',
      manifest: { ...emptyManifest, conflictCount: 1 }
    }).valid).toBe(false);
  });
});

describe('bounded batch redact', () => {
  it.each([
    'stage_cleanup_failed_after_publication',
    'publication_state_unknown'
  ])('aborts the batch for indeterminate commit-barrier failure %s', (reason) => {
    const error = new SafeError({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The publication operation failed safely.',
      retryable: false,
      correlationId: 'cor_cli_batch_redact',
      details: { reason }
    });

    expect(mustAbortBatchRedaction(error, false)).toBe(true);
  });

  it('aborts on every post-return assertion failure but retains safe pre-publication continuation', () => {
    const error = new SafeError({
      code: 'JOB_CONFLICT',
      message: 'The selected artifact changed.',
      retryable: true,
      correlationId: 'cor_cli_batch_redact'
    });

    expect(mustAbortBatchRedaction(error, true)).toBe(true);
    expect(mustAbortBatchRedaction(error, false)).toBe(false);
  });

  it('maps nested supported files into a separate output tree and publishes verified redactions', async () => {
    const input = await temporaryRoot('batch-redact-input-private-');
    const output = await temporaryRoot('batch-redact-output-private-');
    await mkdir(join(input, 'nested'));
    const first = 'Contact alpha@example.test';
    const second = '{"contact":"beta@example.test"}';
    const third = 'Contact gamma@example.test';
    const fourth = 'contact\ndelta@example.test\n';
    await writeFile(join(input, 'one.txt'), first);
    await writeFile(join(input, 'nested', 'two.json'), second);
    await writeFile(join(input, 'three.md'), third);
    await writeFile(join(input, 'nested', 'four.csv'), fourth);
    const inputMetadata = await Promise.all([
      stat(join(input, 'one.txt')),
      stat(join(input, 'nested', 'two.json')),
      stat(join(input, 'three.md')),
      stat(join(input, 'nested', 'four.csv'))
    ]);
    const stream = capture();

    expect(await executeCli(['batch', 'redact', input, '--output', output, '--json'], stream.io)).toBe(0);

    const reportText = stream.stdout.join('');
    expect(JSON.parse(reportText)).toMatchObject({
      schemaVersion: '1.0.0',
      operation: 'BATCH_REDACT',
      outcome: 'SUCCEEDED',
      completionPolicy: 'REQUIRE_COMPLETE',
      manifest: {
        complete: true,
        selectedFileCount: 4,
        publishedFileCount: 4,
        failedFileCount: 0,
        replacementCount: 4,
        failuresByCode: {}
      }
    });
    expect(stream.stderr).toEqual([]);
    expect(reportText).not.toContain(input);
    expect(reportText).not.toContain(output);
    expect(reportText).not.toContain('one.txt');
    expect(reportText).not.toContain('two.json');
    expect(reportText).not.toContain('three.md');
    expect(reportText).not.toContain('four.csv');
    expect(reportText).not.toContain('alpha@example.test');
    expect(reportText).not.toContain('beta@example.test');
    expect(await readFile(join(input, 'one.txt'), 'utf8')).toBe(first);
    expect(await readFile(join(input, 'nested', 'two.json'), 'utf8')).toBe(second);
    expect(await readFile(join(input, 'three.md'), 'utf8')).toBe(third);
    expect(await readFile(join(input, 'nested', 'four.csv'), 'utf8')).toBe(fourth);
    const inputMetadataAfter = await Promise.all([
      stat(join(input, 'one.txt')),
      stat(join(input, 'nested', 'two.json')),
      stat(join(input, 'three.md')),
      stat(join(input, 'nested', 'four.csv'))
    ]);
    expect(inputMetadataAfter.map(({ dev, ino, mode, size, mtimeMs, ctimeMs }) => ({
      dev, ino, mode, size, mtimeMs, ctimeMs
    }))).toEqual(inputMetadata.map(({ dev, ino, mode, size, mtimeMs, ctimeMs }) => ({
      dev, ino, mode, size, mtimeMs, ctimeMs
    })));
    expect(await readFile(join(output, 'one.txt'), 'utf8')).not.toContain('alpha@example.test');
    expect(await readFile(join(output, 'nested', 'two.json'), 'utf8')).not.toContain('beta@example.test');
    expect(await readFile(join(output, 'three.md'), 'utf8')).not.toContain('gamma@example.test');
    expect(await readFile(join(output, 'nested', 'four.csv'), 'utf8')).not.toContain('delta@example.test');
    expect((await stat(join(output, 'one.txt'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(output, 'nested'))).mode & 0o777).toBe(0o700);
    expect(await relativeInventory(output)).toEqual([
      'nested', 'nested/four.csv', 'nested/two.json', 'one.txt', 'three.md'
    ]);
  });

  it('preflights every target before publishing any output', async () => {
    const input = await temporaryRoot();
    const output = await temporaryRoot();
    await writeFile(join(input, 'a.txt'), 'alpha@example.test');
    await writeFile(join(input, 'b.txt'), 'beta@example.test');
    await writeFile(join(output, 'b.txt'), 'existing-output-canary');
    const stream = capture();

    expect(await executeCli(['batch', 'redact', input, '--output', output, '--json'], stream.io)).toBe(6);

    expect(JSON.parse(stream.stderr.join(''))).toMatchObject({ error: { code: 'OUTPUT_COLLISION' } });
    expect(await relativeInventory(output)).toEqual(['b.txt']);
    expect(await readFile(join(output, 'b.txt'), 'utf8')).toBe('existing-output-canary');
    expect(stream.stderr.join('')).not.toContain('existing-output-canary');
  });

  it('rejects nested, identical, and symbolic output roots before processing', async () => {
    const input = await temporaryRoot();
    await writeFile(join(input, 'a.txt'), 'alpha@example.test');
    const nested = join(input, 'nested-output');
    await mkdir(nested);
    const external = await temporaryRoot();
    const link = join(await temporaryRoot(), 'output-link');
    await symlink(external, link, 'dir');

    for (const output of [input, nested, link]) {
      const stream = capture();
      expect(await executeCli(['batch', 'redact', input, '--output', output, '--json'], stream.io)).toBe(3);
      expect(JSON.parse(stream.stderr.join(''))).toMatchObject({ error: { code: 'FORMAT_UNSUPPORTED' } });
    }
    expect(await relativeInventory(external)).toEqual([]);
  });

  it('rejects an observed symbolic parent in the mapped output tree', async () => {
    const input = await temporaryRoot();
    const output = await temporaryRoot();
    const external = await temporaryRoot('batch-output-parent-external-');
    await mkdir(join(input, 'nested'));
    await writeFile(join(input, 'nested', 'private-name.txt'), 'private-value@example.test');
    await symlink(external, join(output, 'nested'), 'dir');
    const stream = capture();

    expect(await executeCli(['batch', 'redact', input, '--output', output, '--json'], stream.io)).toBe(3);
    const error = stream.stderr.join('');
    expect(JSON.parse(error)).toMatchObject({ error: { code: 'FORMAT_UNSUPPORTED' } });
    expect(error).not.toContain(input);
    expect(error).not.toContain(output);
    expect(error).not.toContain(external);
    expect(error).not.toContain('private-name');
    expect(error).not.toContain('private-value');
    expect(await relativeInventory(external)).toEqual([]);
  });

  it('returns a privacy-safe nonzero partial manifest when a later file cannot be redacted', async () => {
    const input = await temporaryRoot('batch-partial-input-private-');
    const output = await temporaryRoot('batch-partial-output-private-');
    await writeFile(join(input, 'a.txt'), 'alpha@example.test');
    await writeFile(join(input, 'z.json'), '{"private-value-canary":');
    const stream = capture();

    expect(await executeCli(['batch', 'redact', input, '--output', output, '--json'], stream.io)).toBe(3);

    const reportText = stream.stdout.join('');
    expect(JSON.parse(reportText)).toMatchObject({
      operation: 'BATCH_REDACT',
      outcome: 'PARTIAL',
      completionPolicy: 'REQUIRE_COMPLETE',
      manifest: {
        complete: false,
        selectedFileCount: 2,
        publishedFileCount: 1,
        failedFileCount: 1,
        failuresByCode: { FORMAT_CORRUPT: 1 }
      }
    });
    expect(stream.stderr).toEqual([]);
    expect(reportText).not.toContain(input);
    expect(reportText).not.toContain(output);
    expect(reportText).not.toContain('a.txt');
    expect(reportText).not.toContain('z.json');
    expect(reportText).not.toContain('alpha@example.test');
    expect(reportText).not.toContain('private-value-canary');
    expect(await relativeInventory(output)).toEqual(['a.txt']);
  });

  it('keeps partial-success policy unavailable for publication batches', async () => {
    const input = await temporaryRoot();
    const output = await temporaryRoot();
    const stream = capture();

    expect(await executeCli([
      'batch', 'redact', input, '--output', output, '--allow-partial', '--json'
    ], stream.io)).toBe(2);
    expect(JSON.parse(stream.stderr.join(''))).toMatchObject({ error: { code: 'SCHEMA_INVALID' } });
  });
});
