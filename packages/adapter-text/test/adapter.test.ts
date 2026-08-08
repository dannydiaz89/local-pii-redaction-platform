import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { rm } from 'node:fs/promises';

import { readTextArtifact, writeTextArtifact } from '../src/index.js';

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
});
