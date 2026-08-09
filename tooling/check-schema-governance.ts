import { detectDeterministic } from '../packages/detectors/src/index.js';
import { parseSha256Digest } from '../packages/domain/src/index.js';
import { loadSchemas, type JsonValue } from './schema-utils.js';

const semanticVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const syntheticRevision = parseSha256Digest(`sha256:${'0'.repeat(64)}`);

function visit(value: JsonValue, path: string, callback: (value: JsonValue, path: string) => void): void {
  callback(value, path);
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      visit(child, `${path}[${String(index)}]`, callback);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, callback);
  }
}

function stringValues(value: JsonValue): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringValues);
  return [];
}

const schemas = loadSchemas();
const ids = new Set<string>();
for (const { relativePath, schema } of schemas) {
  const id = schema.$id;
  const version = schema.schemaVersion;
  if (typeof id !== 'string' || !id.startsWith('https://local-pii.dev/schemas/')) {
    throw new Error(`${relativePath} must have an absolute canonical $id`);
  }
  if (ids.has(id)) throw new Error(`Duplicate canonical schema $id: ${id}`);
  ids.add(id);
  if (typeof version !== 'string' || !semanticVersionPattern.test(version) || !id.endsWith(`/${version}`)) {
    throw new Error(`${relativePath} must bind its semantic schemaVersion to its $id`);
  }
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new Error(`${relativePath} must declare JSON Schema 2020-12`);
  }

  visit(schema, relativePath, (value, path) => {
    if (value !== null && !Array.isArray(value) && typeof value === 'object' && value.type === 'object'
      && !Object.hasOwn(value, 'additionalProperties')) {
      throw new Error(`${path} is an object schema without an explicit extension/closure decision`);
    }
  });

  const examples = schema.examples;
  if (examples !== undefined) {
    for (const exampleString of stringValues(examples)) {
      if (detectDeterministic(exampleString, syntheticRevision).length > 0) {
        throw new Error(`${relativePath} contains a schema example that matches a registered sensitive-data detector`);
      }
    }
  }
}

console.log(`Schema governance passed for ${String(schemas.length)} unique, versioned, closed schemas and privacy-safe examples.`);
