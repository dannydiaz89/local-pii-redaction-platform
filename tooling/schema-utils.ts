import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface LoadedSchema {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly schema: JsonObject;
}

export const repositoryRoot = resolve(import.meta.dirname, '..');
export const schemaRoot = resolve(repositoryRoot, 'packages/contracts/schemas');

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    })
    .filter((path) => path.endsWith('.schema.json'))
    .sort();
}

export function loadJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
}

export function loadSchemas(root = schemaRoot): LoadedSchema[] {
  return walk(root).map((absolutePath) => ({
    absolutePath,
    relativePath: relative(root, absolutePath).split(sep).join('/'),
    schema: loadJson(absolutePath)
  }));
}

export function schemaName(relativePath: string): string {
  return relativePath
    .replace(/\.schema\.json$/u, '')
    .split('/')
    .map((part) => part.split(/[-_]/u).map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(''))
    .join('');
}

export function normalizeReferences(value: JsonValue, currentPath: string, idToPath: ReadonlyMap<string, string>): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeReferences(item, currentPath, idToPath));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const normalized: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith('https://local-pii.dev/')) {
      const hashIndex = child.indexOf('#');
      const id = hashIndex === -1 ? child : child.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? '' : child.slice(hashIndex);
      const target = idToPath.get(id);
      if (target === undefined) {
        throw new Error(`Unresolved schema reference: ${child}`);
      }
      let path = relative(dirname(currentPath), target).split(sep).join('/');
      if (!path.startsWith('.')) path = `./${path}`;
      normalized[key] = `${path}${fragment}`;
    } else {
      normalized[key] = normalizeReferences(child, currentPath, idToPath);
    }
  }
  return normalized;
}
