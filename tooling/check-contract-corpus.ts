import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  batchScanReportSchemaIds,
  batchScanReportSemanticErrors
} from '../packages/contracts/src/batch-scan-report.js';
import {
  batchRedactReportSchemaId,
  batchRedactReportSemanticErrors
} from '../packages/contracts/src/batch-redact-report.js';
import { isCanonicalUuid, isRfc3339DateTime } from '../packages/contracts/src/formats.js';

import { loadJson, loadSchemas, repositoryRoot } from './schema-utils.js';

interface CorpusCase {
  readonly file: string;
  readonly schemaId: string;
  readonly valid: boolean;
}

interface CorpusManifest {
  readonly cases: readonly CorpusCase[];
}

const semanticVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

const schemas = loadSchemas();
const ids = new Set<string>();
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
ajv.addFormat('uuid', isCanonicalUuid);
ajv.addFormat('date-time', isRfc3339DateTime);
ajv.addFormat('uri', (value: string) => {
  try { return new URL(value).protocol.length > 1; } catch { return false; }
});
ajv.addKeyword({ keyword: 'schemaVersion', schemaType: 'string', valid: true });

for (const item of schemas) {
  const { $id, title, description, schemaVersion, examples } = item.schema;
  if (typeof $id !== 'string' || ids.has($id)) throw new Error(`Missing or duplicate $id: ${item.relativePath}`);
  if (
    typeof title !== 'string'
    || typeof description !== 'string'
    || typeof schemaVersion !== 'string'
    || !semanticVersionPattern.test(schemaVersion)
    || !$id.endsWith(`/${schemaVersion}`)
  ) {
    throw new Error(`Incomplete schema metadata: ${item.relativePath}`);
  }
  if (!Array.isArray(examples) || examples.length === 0) throw new Error(`Schema needs synthetic examples: ${item.relativePath}`);
  ids.add($id);
  ajv.addSchema(item.schema);
}

for (const item of schemas) {
  const id = item.schema.$id as string;
  const validate = ajv.getSchema(id);
  if (validate === undefined) throw new Error(`Schema did not compile: ${id}`);
  for (const example of item.schema.examples as readonly unknown[]) {
    if (!validate(example)) throw new Error(`Invalid example in ${item.relativePath}: ${JSON.stringify(validate.errors)}`);
  }
}

const corpusRoot = resolve(repositoryRoot, 'fixtures/contracts');
const manifest = JSON.parse(readFileSync(resolve(corpusRoot, 'manifest.json'), 'utf8')) as CorpusManifest;
for (const testCase of manifest.cases) {
  const validate = ajv.getSchema(testCase.schemaId);
  if (validate === undefined) throw new Error(`Unknown corpus schema: ${testCase.schemaId}`);
  const value = loadJson(resolve(corpusRoot, testCase.file));
  const schemaValid = validate(value) === true;
  const semanticValid = !schemaValid
    || (batchScanReportSchemaIds.has(testCase.schemaId)
      ? batchScanReportSemanticErrors(value as Parameters<typeof batchScanReportSemanticErrors>[0]).length === 0
      : testCase.schemaId === batchRedactReportSchemaId
        ? batchRedactReportSemanticErrors(value as Parameters<typeof batchRedactReportSemanticErrors>[0]).length === 0
        : true);
  const actualValid = schemaValid && semanticValid;
  if (actualValid !== testCase.valid) {
    throw new Error(`${testCase.file}: expected valid=${String(testCase.valid)}, got ${String(actualValid)}: ${JSON.stringify(validate.errors)}`);
  }
}

console.log(`Validated ${String(schemas.length)} schemas and ${String(manifest.cases.length)} cross-language fixtures.`);
