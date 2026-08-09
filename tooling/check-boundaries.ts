import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { repositoryRoot } from './schema-utils.js';

const forbiddenDomainImports = ['node:fs', 'node:net', 'node:http', 'node:https', 'node:child_process', 'fastify', 'express'];
const forbiddenPackageFrameworkImports = ['fastify', 'hono', '@hono/node-server', 'express'];
const packageRoot = resolve(repositoryRoot, 'packages');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const violations: string[] = [];
for (const path of sourceFiles(resolve(repositoryRoot, 'packages/domain/src'))) {
  const source = readFileSync(path, 'utf8');
  for (const moduleName of forbiddenDomainImports) {
    if (source.includes(`from '${moduleName}`) || source.includes(`from "${moduleName}`)) {
      violations.push(`${relative(repositoryRoot, path)} imports forbidden module ${moduleName}`);
    }
  }
  if (source.includes('@local-pii/')) violations.push(`${relative(repositoryRoot, path)} imports another workspace package`);
}

for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = resolve(packageRoot, entry.name);
  const manifestPath = resolve(directory, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { readonly name?: unknown; readonly exports?: unknown };
  if (typeof manifest.name !== 'string' || manifest.name !== `@local-pii/${entry.name}`) {
    violations.push(`${relative(repositoryRoot, manifestPath)} has an unexpected package name`);
  }
  if (manifest.exports === null || typeof manifest.exports !== 'object' || Array.isArray(manifest.exports)
    || JSON.stringify(manifest.exports) !== JSON.stringify({ '.': './dist/index.js' })) {
    violations.push(`${relative(repositoryRoot, manifestPath)} must expose only the public package root`);
  }
}

for (const root of [resolve(repositoryRoot, 'packages'), resolve(repositoryRoot, 'apps')]) {
  for (const path of sourceFiles(root)) {
    const source = readFileSync(path, 'utf8');
    const internalWorkspaceImports = source.matchAll(/from\s+['"](@local-pii\/[a-z0-9-]+\/[^'"]+)['"]/gu);
    for (const match of internalWorkspaceImports) {
      violations.push(`${relative(repositoryRoot, path)} imports non-public workspace path ${match[1] ?? ''}`);
    }
  }
}

for (const path of sourceFiles(resolve(repositoryRoot, 'packages'))) {
  const source = readFileSync(path, 'utf8');
  for (const moduleName of forbiddenPackageFrameworkImports) {
    if (source.includes(`from '${moduleName}`) || source.includes(`from "${moduleName}`)) {
      violations.push(`${relative(repositoryRoot, path)} imports HTTP framework ${moduleName}`);
    }
  }
}

if (violations.length > 0) throw new Error(`Dependency boundary violations:\n${violations.join('\n')}`);
console.log('Dependency boundaries are valid.');
