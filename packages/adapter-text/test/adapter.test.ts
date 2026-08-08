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
