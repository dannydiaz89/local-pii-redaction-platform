import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { repositoryRoot } from './schema-utils.js';

const forbiddenDomainImports = ['node:fs', 'node:net', 'node:http', 'node:https', 'node:child_process', 'fastify', 'express'];

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

if (violations.length > 0) throw new Error(`Dependency boundary violations:\n${violations.join('\n')}`);
console.log('Dependency boundaries are valid.');
