import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from 'json-schema-to-typescript';

import { loadSchemas, normalizeReferences, repositoryRoot, schemaName, type JsonObject } from './schema-utils.js';

const banner = '// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.\n\n';

export async function generateTypescript(outputRoot: string): Promise<void> {
  const schemas = loadSchemas();
  const normalizedRoot = resolve(repositoryRoot, '.contract-generation/normalized-schemas');
  rmSync(normalizedRoot, { recursive: true, force: true });

  const idToPath = new Map<string, string>();
  for (const item of schemas) {
    const id = item.schema.$id;
    if (typeof id !== 'string') throw new Error(`${item.relativePath} has no $id`);
    idToPath.set(id, resolve(normalizedRoot, item.relativePath));
  }

  for (const item of schemas) {
    const path = resolve(normalizedRoot, item.relativePath);
    mkdirSync(dirname(path), { recursive: true });
    const normalized = normalizeReferences(item.schema, path, idToPath);
    writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
  }

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  const exports: string[] = [];
  for (const item of schemas) {
    const outputName = item.relativePath.replace(/\.schema\.json$/u, '').replaceAll('/', '-');
    const normalized = normalizeReferences(item.schema, resolve(normalizedRoot, item.relativePath), idToPath) as JsonObject;
    const source = await compile(normalized, schemaName(item.relativePath), {
      bannerComment: banner.trimEnd(),
      cwd: dirname(resolve(normalizedRoot, item.relativePath)),
      style: { singleQuote: true, semi: true, tabWidth: 2 },
      unreachableDefinitions: true
    });
    writeFileSync(resolve(outputRoot, `${outputName}.ts`), source);
    exports.push(`export * as ${schemaName(item.relativePath)}Contract from './${outputName}.js';`);
  }

  const catalog = schemas.map((item) => item.schema);
  writeFileSync(resolve(outputRoot, 'schema-catalog.ts'), `${banner}export const schemaCatalog = ${JSON.stringify(catalog, null, 2)} as const;\n`);
  writeFileSync(resolve(outputRoot, 'index.ts'), `${banner}${exports.join('\n')}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputFlag = process.argv.indexOf('--out');
  const outputRoot = outputFlag >= 0 && process.argv[outputFlag + 1] !== undefined
    ? resolve(process.argv[outputFlag + 1] as string)
    : resolve(repositoryRoot, 'packages/contracts/src/generated');
  await generateTypescript(outputRoot);
}
