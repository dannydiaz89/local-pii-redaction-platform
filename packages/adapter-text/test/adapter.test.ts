import { execFile } from 'node:child_process';
import { appendFile, link as hardLink, mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseSha256Digest } from '@local-pii/domain';
import { compileTypedLabelPlan, type TypedLabelPlan } from '@local-pii/redaction';

import { rm } from 'node:fs/promises';

import {
  createEphemeralTextArtifactSession,
  createLocalTextArtifactSession,
  createTextWriterReceipt,
  cleanupStaleTextStages,
  defaultTextArtifactFileSystem,
  discardStagedTextArtifact,
  inventoryTextStages,
  readTextArtifact,
  stageTextArtifact,
  writeTextArtifact,
  assertTextWriterReceiptIntegrity,
  type StagedTextArtifact,
  type TextArtifact,
  type TextArtifactFileSystem
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

function filesystemFailure(code = 'EIO'): NodeJS.ErrnoException {
  return Object.assign(new Error('sensitive native filesystem detail'), { code });
}

function faultFileSystem(overrides: Partial<TextArtifactFileSystem>): TextArtifactFileSystem {
  return { ...defaultTextArtifactFileSystem, ...overrides };
}

async function stageEntries(root: string): Promise<string[]> {
  return (await readdir(root)).filter((entry) => entry.includes('.staged')).sort();
}

describe('text adapter', () => {
  it('stages, reopens, publishes, and disposes a process-local typed-label output', async () => {
    const root = await directory();
    const input = join(root, 'ephemeral-source.txt');
    await writeFile(input, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alice@example.test')]));
    const { path, ...source } = await readTextArtifact(input);
    const handle = createEphemeralTextArtifactSession(source, 1024);

    const staged = await handle.session.stage(typedLabelPlan(await handle.session.input()));
    const reopened = await handle.session.reopen(staged);
    const published = await handle.session.publish(staged);

    expect(reopened.text).toBe('[EMAIL_1]');
    expect(path.endsWith('/ephemeral-source.txt')).toBe(true);
    expect(reopened.digest).toBe(staged.digest);
    expect(published).toMatchObject({
      reference: 'ephemeral:published',
      digest: staged.digest,
      byteLength: staged.byteLength
    });
    expect(handle.publishedBytes()).toEqual(
      Uint8Array.from(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[EMAIL_1]')]))
    );
    expect(await readFile(input)).toEqual(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alice@example.test')])
    );

    handle.dispose();
    expect(handle.publishedBytes()).toBeUndefined();
  });

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

  it('normalizes an injected stage-open failure without creating a stage', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    const source = await readTextArtifact(input);
    const fileSystem = faultFileSystem({ open: () => Promise.reject(filesystemFailure()) });

    await expect(stageTextArtifact(source, output, '[EMAIL_1]', fileSystem)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The staged artifact could not be created.'
    });
    expect(await stageEntries(root)).toEqual([]);
    expect(await readFile(input, 'utf8')).toBe('alice@example.test');
  });

  it('does not unlink an unowned pathname after an ambiguous stage-open failure', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    const source = await readTextArtifact(input);
    let ambiguousPath = '';
    const fileSystem = faultFileSystem({
      open: async (path) => {
        ambiguousPath = path;
        await writeFile(path, 'concurrently-owned bytes');
        throw filesystemFailure();
      }
    });

    await expect(stageTextArtifact(source, output, '[EMAIL_1]', fileSystem)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The staged artifact could not be created.'
    });
    expect(await readFile(ambiguousPath, 'utf8')).toBe('concurrently-owned bytes');
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['writeFile', 'sync', 'close'] as const)(
    'removes the temporary stage and normalizes an injected stage-%s failure',
    async (phase) => {
      const root = await directory();
      const input = join(root, 'input.txt');
      const output = join(root, 'output.txt');
      await writeFile(input, 'alice@example.test');
      const source = await readTextArtifact(input);
      const fileSystem = faultFileSystem({
        open: async (...arguments_) => {
          const handle = await defaultTextArtifactFileSystem.open(...arguments_);
          return {
            writeFile: async (bytes) => {
              if (phase === 'writeFile') throw filesystemFailure();
              await handle.writeFile(bytes);
            },
            sync: async () => {
              if (phase === 'sync') throw filesystemFailure();
              await handle.sync();
            },
            close: async () => {
              await handle.close();
              if (phase === 'close') throw filesystemFailure();
            }
          };
        }
      });

      await expect(stageTextArtifact(source, output, '[EMAIL_1]', fileSystem)).rejects.toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
        message: 'The staged artifact could not be written.'
      });
      expect(await stageEntries(root)).toEqual([]);
      expect(await readFile(input, 'utf8')).toBe('alice@example.test');
    }
  );

  it('does not claim failed-stage cleanup when the injected unlink cannot be confirmed', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    const source = await readTextArtifact(input);
    const fileSystem = faultFileSystem({
      open: async (...arguments_) => {
        const handle = await defaultTextArtifactFileSystem.open(...arguments_);
        return {
          writeFile: () => Promise.reject(filesystemFailure()),
          sync: () => handle.sync(),
          close: () => handle.close()
        };
      },
      unlink: () => Promise.reject(filesystemFailure())
    });

    await expect(stageTextArtifact(source, output, '[EMAIL_1]', fileSystem)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The staged artifact cleanup could not be confirmed.',
      details: { reason: 'stage_cleanup_failed' }
    });
    expect(await stageEntries(root)).toHaveLength(1);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the temporary stage and normalizes an injected stage-readback failure', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    const source = await readTextArtifact(input);
    const fileSystem = faultFileSystem({
      readFile: async (path) => {
        if (path.includes('.staged')) throw filesystemFailure();
        return defaultTextArtifactFileSystem.readFile(path);
      }
    });

    await expect(stageTextArtifact(source, output, '[EMAIL_1]', fileSystem)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The staged artifact could not be verified.'
    });
    expect(await stageEntries(root)).toEqual([]);
    expect(await readFile(input, 'utf8')).toBe('alice@example.test');
  });

  it('normalizes an injected reopen read failure and leaves its existing stage untouched', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    const writer = createLocalTextArtifactSession(input, output);
    const staged = await writer.stage(typedLabelPlan(await writer.input()));
    const reader = createLocalTextArtifactSession(input, output, undefined, faultFileSystem({
      openRead: async (path) => {
        if (path.includes('.staged')) throw filesystemFailure();
        return defaultTextArtifactFileSystem.openRead(path);
      }
    }));

    await expect(reader.reopen(staged)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The input could not be read.'
    });
    expect(await stageEntries(root)).toEqual([staged.path.split('/').at(-1)]);
    expect(await readFile(staged.path, 'utf8')).toBe('[EMAIL_1]');
  });

  it('normalizes an injected publication-link failure and leaves the stage recoverable', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    const fileSystem = faultFileSystem({ link: () => Promise.reject(filesystemFailure()) });
    const session = createLocalTextArtifactSession(input, output, undefined, fileSystem);
    const staged = await session.stage(typedLabelPlan(await session.input()));

    await expect(session.publish(staged)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The staged artifact could not be published.'
    });
    expect(await stageEntries(root)).toEqual([staged.path.split('/').at(-1)]);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats an identical but independently created output as a collision after a link error', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    const fileSystem = faultFileSystem({
      link: () => Promise.reject(filesystemFailure('EEXIST'))
    });
    const session = createLocalTextArtifactSession(input, output, undefined, fileSystem);
    const staged = await session.stage(typedLabelPlan(await session.input()));
    await writeFile(output, '[EMAIL_1]');

    await expect(session.publish(staged)).rejects.toMatchObject({
      code: 'OUTPUT_COLLISION',
      message: 'The output path already exists.'
    });
    expect(await readFile(output, 'utf8')).toBe('[EMAIL_1]');
    expect(await stageEntries(root)).toEqual([staged.path.split('/').at(-1)]);
  });

  it('keeps the verified output when post-publication stage cleanup fails', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    let stagedPath = '';
    const fileSystem = faultFileSystem({
      unlink: async (path) => {
        if (path === stagedPath) throw filesystemFailure();
        await defaultTextArtifactFileSystem.unlink(path);
      }
    });
    const session = createLocalTextArtifactSession(input, output, undefined, fileSystem);
    const staged = await session.stage(typedLabelPlan(await session.input()));
    stagedPath = staged.path;

    await expect(session.publish(staged)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'A verified output was published, but staged artifact cleanup could not be confirmed.',
      details: { reason: 'stage_cleanup_failed_after_publication' },
      retryable: false
    });
    expect(await stageEntries(root)).toEqual([staged.path.split('/').at(-1)]);
    expect(await readFile(output, 'utf8')).toBe('[EMAIL_1]');
  });

  it('returns publication success after a transient post-commit cleanup failure', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    let stagedPath = '';
    let stageUnlinkAttempts = 0;
    const fileSystem = faultFileSystem({
      unlink: async (path) => {
        if (path === stagedPath && stageUnlinkAttempts++ === 0) throw filesystemFailure();
        await defaultTextArtifactFileSystem.unlink(path);
      }
    });
    const session = createLocalTextArtifactSession(input, output, undefined, fileSystem);
    const staged = await session.stage(typedLabelPlan(await session.input()));
    stagedPath = staged.path;

    await expect(session.publish(staged)).resolves.toMatchObject({ reference: output });
    expect(stageUnlinkAttempts).toBe(2);
    expect(await stageEntries(root)).toEqual([]);
    expect(await readFile(output, 'utf8')).toBe('[EMAIL_1]');
  });

  it('preserves post-publication cleanup status through the one-shot writer', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    const source = await readTextArtifact(input);
    const fileSystem = faultFileSystem({
      unlink: async (path) => {
        if (path.includes('.staged')) throw filesystemFailure();
        await defaultTextArtifactFileSystem.unlink(path);
      }
    });

    await expect(writeTextArtifact(source, output, '[EMAIL_1]', fileSystem)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      details: { reason: 'stage_cleanup_failed_after_publication' },
      retryable: false
    });
    expect(await stageEntries(root)).toHaveLength(1);
    expect(await readFile(output, 'utf8')).toBe('[EMAIL_1]');
  });

  it('reconciles a link error after its side effect without deleting the verified output', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    const fileSystem = faultFileSystem({
      link: async (existingPath, targetPath) => {
        await defaultTextArtifactFileSystem.link(existingPath, targetPath);
        throw filesystemFailure();
      }
    });
    const session = createLocalTextArtifactSession(input, output, undefined, fileSystem);
    const staged = await session.stage(typedLabelPlan(await session.input()));

    await expect(session.publish(staged)).resolves.toMatchObject({ reference: output });
    expect(await stageEntries(root)).toEqual([]);
    expect(await readFile(output, 'utf8')).toBe('[EMAIL_1]');
  });

  it('reconciles an unlink error after its side effect as successful publication', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    let stagedPath = '';
    const fileSystem = faultFileSystem({
      unlink: async (path) => {
        await defaultTextArtifactFileSystem.unlink(path);
        if (path === stagedPath) throw filesystemFailure();
      }
    });
    const session = createLocalTextArtifactSession(input, output, undefined, fileSystem);
    const staged = await session.stage(typedLabelPlan(await session.input()));
    stagedPath = staged.path;

    await expect(session.publish(staged)).resolves.toMatchObject({ reference: output });
    expect(await stageEntries(root)).toEqual([]);
    expect(await readFile(output, 'utf8')).toBe('[EMAIL_1]');
  });

  it('does not report success when link returns without creating the output', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    const fileSystem = faultFileSystem({ link: () => Promise.resolve() });
    const session = createLocalTextArtifactSession(input, output, undefined, fileSystem);
    const staged = await session.stage(typedLabelPlan(await session.input()));

    await expect(session.publish(staged)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      details: { reason: 'publication_state_unknown' },
      retryable: false
    });
    expect(await stageEntries(root)).toEqual([staged.path.split('/').at(-1)]);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an unconfirmed link outcome without retrying or deleting either artifact', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'output.txt');
    await writeFile(input, 'alice@example.test');
    const fileSystem = faultFileSystem({
      link: async (existingPath, targetPath) => {
        await defaultTextArtifactFileSystem.link(existingPath, targetPath);
        throw filesystemFailure();
      },
      lstat: async (path) => {
        if (path === output) throw filesystemFailure();
        return defaultTextArtifactFileSystem.lstat(path);
      }
    });
    const session = createLocalTextArtifactSession(input, output, undefined, fileSystem);
    const staged = await session.stage(typedLabelPlan(await session.input()));

    await expect(session.publish(staged)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The publication state could not be confirmed.',
      details: { reason: 'publication_state_unknown' },
      retryable: false
    });
    expect(await stageEntries(root)).toEqual([staged.path.split('/').at(-1)]);
    expect(await readFile(output, 'utf8')).toBe('[EMAIL_1]');
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

  it.skipIf(process.platform === 'win32')('rejects a FIFO replacement without waiting for a writer', async () => {
    const root = await directory();
    const regular = join(root, 'regular.txt');
    const fifo = join(root, 'replacement.txt');
    await writeFile(regular, 'synthetic input');
    await new Promise<void>((resolveResult, reject) => {
      execFile('/usr/bin/mkfifo', [fifo], (error) => {
        if (error === null) resolveResult();
        else reject(new Error('FIFO fixture could not be created.'));
      });
    });
    const regularMetadata = await stat(regular);
    const fileSystem = faultFileSystem({
      lstat: () => Promise.resolve(regularMetadata),
      realpath: () => Promise.resolve(fifo)
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('FIFO read exceeded its bounded outcome.'));
      }, 1_000);
    });

    try {
      await expect(Promise.race([readTextArtifact(regular, undefined, fileSystem), deadline])).rejects.toMatchObject({
        code: 'FORMAT_UNSUPPORTED',
        message: 'The input must be a regular file.'
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'rejects an invalid byte limit before touching the filesystem: %s',
    async (maximumBytes) => {
      let filesystemCalls = 0;
      const fileSystem = faultFileSystem({
        lstat: () => {
          filesystemCalls += 1;
          return Promise.reject(filesystemFailure());
        }
      });

      await expect(readTextArtifact('synthetic.txt', maximumBytes, fileSystem)).rejects.toThrow(TypeError);
      expect(filesystemCalls).toBe(0);
    }
  );

  it('accepts an input at the exact byte limit and rejects limit plus one before reading file content', async () => {
    const root = await directory();
    const exact = join(root, 'exact.txt');
    const over = join(root, 'over.txt');
    await Promise.all([writeFile(exact, '1234'), writeFile(over, '12345')]);

    await expect(readTextArtifact(exact, 4)).resolves.toMatchObject({ byteLength: 4, text: '1234' });

    let readCalls = 0;
    const fileSystem = faultFileSystem({
      openRead: async (path) => {
        const handle = await defaultTextArtifactFileSystem.openRead(path);
        return {
          stat: () => handle.stat(),
          read: async (...arguments_) => {
            readCalls += 1;
            return await handle.read(...arguments_);
          },
          close: () => handle.close()
        };
      }
    });
    await expect(readTextArtifact(over, 4, fileSystem)).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
    expect(readCalls).toBe(0);
  });

  it('reads at most limit plus one bytes when an opened input grows after metadata validation', async () => {
    const root = await directory();
    const input = join(root, 'growing.txt');
    await writeFile(input, '1234');
    let grew = false;
    const requestedLengths: number[] = [];
    const fileSystem = faultFileSystem({
      openRead: async (path) => {
        const handle = await defaultTextArtifactFileSystem.openRead(path);
        return {
          stat: async () => {
            const initial = await handle.stat();
            if (!grew) {
              grew = true;
              await appendFile(path, '56');
            }
            return initial;
          },
          read: async (buffer, offset, length, position) => {
            requestedLengths.push(length);
            return await handle.read(buffer, offset, length, position);
          },
          close: () => handle.close()
        };
      }
    });

    await expect(readTextArtifact(input, 4, fileSystem)).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
    expect(requestedLengths).toEqual([5]);
    expect(await readFile(input, 'utf8')).toBe('123456');
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

  it('applies multiple Unicode code-point actions in one forward pass without changing canonical receipt order', async () => {
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

  it('rejects publication when the declared staged byte length is not exact', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'redacted.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input, output);
    const staged = await session.stage(typedLabelPlan(await session.input()));

    await expect(session.publish({ ...staged, byteLength: staged.byteLength + 1 })).rejects.toMatchObject({
      code: 'ARTIFACT_DIGEST_MISMATCH'
    });
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

  it('skips a hard-linked lookalike unless its other link is the exact selected output', async () => {
    const root = await directory();
    const output = join(root, 'report.txt');
    const unrelated = join(root, 'unrelated.txt');
    const stage = join(root, stageName('report', '66666666-6666-4666-8666-666666666666'));
    await writeFile(unrelated, 'user-owned bytes');
    await hardLink(unrelated, stage);
    await makeStale(stage);

    const result = await cleanupStaleTextStages({ outputPath: output, minimumAgeMs: 60_000 });

    expect(result).toMatchObject({
      matchingStageFileCount: 1,
      staleStageFileCount: 0,
      skippedUnsafeEntryCount: 1,
      deletedStageFileCount: 0
    });
    expect(await readFile(stage, 'utf8')).toBe('user-owned bytes');
    expect(await readFile(unrelated, 'utf8')).toBe('user-owned bytes');
  });

  it('cleans an old post-publication hard link only when bound to the selected output', async () => {
    const root = await directory();
    const output = join(root, 'report.txt');
    const stage = join(root, stageName('report', '77777777-7777-4777-8777-777777777777'));
    await writeFile(output, 'verified output');
    await hardLink(output, stage);
    await makeStale(stage);

    const result = await cleanupStaleTextStages({ outputPath: output, minimumAgeMs: 60_000 });

    expect(result).toMatchObject({ staleStageFileCount: 1, deletedStageFileCount: 1 });
    expect(await readFile(output, 'utf8')).toBe('verified output');
    await expect(readFile(stage)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the fault seam for bounded recovery inventory and deletion', async () => {
    const root = await directory();
    const output = join(root, 'report.txt');
    const stage = join(root, stageName('report', '88888888-8888-4888-8888-888888888888'));
    await writeFile(stage, 'private stage');
    await makeStale(stage);

    await expect(inventoryTextStages({
      outputPath: output,
      minimumAgeMs: 60_000,
      fileSystem: faultFileSystem({ opendir: () => Promise.reject(filesystemFailure()) })
    })).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The selected staging directory is unavailable.'
    });

    const cleanup = await cleanupStaleTextStages({
      outputPath: output,
      minimumAgeMs: 60_000,
      fileSystem: faultFileSystem({ unlink: () => Promise.reject(filesystemFailure()) })
    });
    expect(cleanup).toMatchObject({
      staleStageFileCount: 1,
      deletedStageFileCount: 0,
      deletionFailureCount: 1
    });
    expect(await readFile(stage, 'utf8')).toBe('private stage');
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
