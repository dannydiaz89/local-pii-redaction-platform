import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseSha256Digest } from '@local-pii/domain';

import { rm } from 'node:fs/promises';

import {
  createLocalTextArtifactSession,
  discardStagedTextArtifact,
  readTextArtifact,
  writeTextArtifact,
  type StagedTextArtifact
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
    expect(session.writer).toEqual({ id: 'text-adapter', version: '0.1.0' });
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

    const staged = await session.stage('[EMAIL_1]');
    expect((await stat(staged.path)).mode & 0o777).toBe(0o600);
    const reopened = await session.reopen(staged);
    expect(reopened.digest).toBe(staged.digest);
    expect(reopened.byteLength).toBe(staged.byteLength);
    expect(await readFile(staged.path, 'utf8')).toBe('[EMAIL_1]');

    await writeFile(output, 'must-not-be-replaced');
    await expect(session.publish(staged)).rejects.toMatchObject({ code: 'OUTPUT_COLLISION' });
    expect(await readFile(output, 'utf8')).toBe('must-not-be-replaced');
    await session.discard(staged);
  });

  it('rejects publication when the source changes after staging', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'redacted.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input, output);
    const staged = await session.stage('[EMAIL_1]');
    await writeFile(input, 'changed@example.test');

    await expect(session.publish(staged)).rejects.toMatchObject({ code: 'JOB_CONFLICT' });
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    await session.discard(staged);
  });

  it('publishes an absolute, storage-neutral reference for the CLI', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    const output = join(root, 'redacted.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input, output);
    const staged = await session.stage('[EMAIL_1]');

    const published = await session.publish(staged);

    expect(published).toMatchObject({ reference: output, digest: staged.digest, byteLength: staged.byteLength });
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

    await expect(session.stage('[EMAIL_1]', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

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

    await expect(session.stage('[EMAIL_1]', signal)).rejects.toMatchObject({ name: 'AbortError' });

    expect(await readdir(root)).toEqual(['input.txt']);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('makes discard idempotent and signals unexpected cleanup failures safely', async () => {
    const root = await directory();
    const input = join(root, 'input.txt');
    await writeFile(input, 'alice@example.test');
    const session = createLocalTextArtifactSession(input);
    const staged = await session.stage('[EMAIL_1]');

    await session.discard(staged);
    await expect(session.discard(staged)).resolves.toBeUndefined();

    const directoryAtStagedPath = join(root, 'not-a-file.staged.txt');
    await mkdir(directoryAtStagedPath);
    const invalidStage: StagedTextArtifact = {
      reference: directoryAtStagedPath,
      path: directoryAtStagedPath,
      targetPath: join(root, 'out.txt'),
      byteLength: 0,
      digest: parseSha256Digest('sha256:0000000000000000000000000000000000000000000000000000000000000000')
    };
    await expect(discardStagedTextArtifact(invalidStage)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The staged artifact could not be removed.'
    });
  });
});
