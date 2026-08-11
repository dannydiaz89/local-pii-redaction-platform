import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalSdkPublicApiSnapshot,
  createSdkPublicApiSnapshot
} from './check-sdk-public-api.js';
import { repositoryRoot } from './schema-utils.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function fixture(source: string): Promise<Readonly<{ configPath: string; entryPath: string }>> {
  const root = await mkdtemp(join(tmpdir(), 'local-pii-sdk-api-'));
  temporaryDirectories.push(root);
  const entryPath = join(root, 'index.ts');
  const configPath = join(root, 'tsconfig.json');
  await writeFile(entryPath, source);
  await writeFile(configPath, JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      declaration: true, exactOptionalPropertyTypes: true
    },
    include: ['index.ts']
  }));
  return { configPath, entryPath };
}

describe('SDK public API compatibility gate', () => {
  it('matches the reviewed package-root baseline deterministically', async () => {
    const baseline = await import('node:fs/promises').then(async ({ readFile }) => readFile(
      resolve(repositoryRoot, 'tooling/sdk-public-api-baseline.json'), 'utf8'
    ));
    expect(canonicalSdkPublicApiSnapshot(createSdkPublicApiSnapshot())).toBe(baseline);
    expect(createSdkPublicApiSnapshot()).toEqual(createSdkPublicApiSnapshot());
  });

  it.each([
    ['removed export', 'export interface Result { readonly state: "READY"; optional?: string }'],
    ['type-to-value drift', 'export interface Result { readonly state: "READY"; optional?: string }\nexport const Mode = "A";\nexport function run(value: string): Result { return { state: "READY" }; }'],
    ['parameter drift', 'export interface Result { readonly state: "READY"; optional?: string }\nexport type Mode = "A" | "B";\nexport function run(value?: string): Promise<Result> { return Promise.resolve({ state: "READY" }); }'],
    ['return drift', 'export interface Result { readonly state: "READY"; optional?: string }\nexport type Mode = "A" | "B";\nexport function run(value: string): Result { return { state: "READY" }; }'],
    ['readonly and optionality drift', 'export interface Result { state: "READY"; optional: string }\nexport type Mode = "A" | "B";\nexport function run(value: string): Promise<Result> { return Promise.resolve({ state: "READY", optional: "x" }); }'],
    ['literal drift', 'export interface Result { readonly state: "DONE"; optional?: string }\nexport type Mode = "A" | "C";\nexport function run(value: string): Promise<Result> { return Promise.resolve({ state: "DONE" }); }']
  ])('detects %s', async (_label, changedSource) => {
    const original = await fixture([
      'export interface Result { readonly state: "READY"; optional?: string }',
      'export type Mode = "A" | "B";',
      'export function run(value: string): Promise<Result> { return Promise.resolve({ state: "READY" }); }'
    ].join('\n'));
    const changed = await fixture(changedSource);
    expect(createSdkPublicApiSnapshot(changed)).not.toEqual(createSdkPublicApiSnapshot(original));
  });
});
