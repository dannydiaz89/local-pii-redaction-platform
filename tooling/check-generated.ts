import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { generateTypescript } from './generate-typescript.js';
import { repositoryRoot } from './schema-utils.js';

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }).filter((path) => !path.endsWith('.pyc'));
}

function compareDirectories(expected: string, actual: string): string[] {
  const expectedFiles = new Map(files(expected).map((path) => [relative(expected, path), readFileSync(path)]));
  const actualFiles = new Map(files(actual).map((path) => [relative(actual, path), readFileSync(path)]));
  const names = new Set([...expectedFiles.keys(), ...actualFiles.keys()]);
  return [...names].sort().filter((name) => {
    const left = expectedFiles.get(name);
    const right = actualFiles.get(name);
    return left === undefined || right === undefined || !left.equals(right);
  });
}

const generatedTypescript = resolve(repositoryRoot, 'packages/contracts/src/generated_check');
const generatedPython = resolve(repositoryRoot, 'services/inference-python/src/local_pii_inference/generated_check');
rmSync(generatedTypescript, { recursive: true, force: true });
rmSync(generatedPython, { recursive: true, force: true });
await generateTypescript(generatedTypescript);

const python = spawnSync(
  resolve(repositoryRoot, '.venv/bin/python'),
  [resolve(repositoryRoot, 'services/inference-python/scripts/generate_models.py'), '--output', generatedPython],
  { cwd: repositoryRoot, encoding: 'utf8' }
);
if (python.status !== 0) throw new Error(`Python model generation failed:\n${python.stderr}`);

const changed = [
  ...compareDirectories(resolve(repositoryRoot, 'packages/contracts/src/generated'), generatedTypescript).map((path) => `TypeScript: ${path}`),
  ...compareDirectories(resolve(repositoryRoot, 'services/inference-python/src/local_pii_inference/generated'), generatedPython).map((path) => `Python: ${path}`)
];
rmSync(generatedTypescript, { recursive: true, force: true });
rmSync(generatedPython, { recursive: true, force: true });

if (changed.length > 0) throw new Error(`Generated contracts drifted:\n${changed.join('\n')}\nRun pnpm generate.`);
console.log('Generated TypeScript and Python contracts are drift-free.');
