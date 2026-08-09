import { resolve } from 'node:path';

import { detectorSources, entityTypes, errorCodes, jobStates, safeErrorDetailKeys } from '../packages/domain/src/index.js';

import { loadJson, schemaRoot, type JsonValue } from './schema-utils.js';

function at(value: JsonValue, path: readonly string[]): JsonValue {
  let current = value;
  for (const segment of path) {
    if (current === null || Array.isArray(current) || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`Missing schema path: ${path.join('.')}`);
    }
    current = current[segment] as JsonValue;
  }
  return current;
}

function stringArray(value: JsonValue, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}

function assertSame(label: string, domainValues: readonly string[], contractValues: readonly string[]): void {
  if (JSON.stringify(domainValues) !== JSON.stringify(contractValues)) {
    throw new Error(`${label} drifted between the domain and canonical contract`);
  }
}

const entitySchema = loadJson(resolve(schemaRoot, 'common/entity-type.schema.json'));
const errorSchema = loadJson(resolve(schemaRoot, 'common/errors-v2.schema.json'));
const jobSchema = loadJson(resolve(schemaRoot, 'jobs/job.schema.json'));
const detectionSchema = loadJson(resolve(schemaRoot, 'detection/detection.schema.json'));

assertSame('Entity types', entityTypes, stringArray(at(entitySchema, ['enum']), 'entity enum'));
assertSame('Error codes', errorCodes, stringArray(at(errorSchema, ['properties', 'error', 'properties', 'code', 'enum']), 'error-code enum'));
assertSame(
  'Safe error detail keys',
  safeErrorDetailKeys,
  stringArray(at(errorSchema, ['properties', 'error', 'properties', 'details', 'propertyNames', 'enum']), 'safe-detail-key enum')
);
assertSame('Job states', jobStates, stringArray(at(jobSchema, ['properties', 'state', 'enum']), 'job-state enum'));
assertSame(
  'Detector sources',
  detectorSources,
  stringArray(at(detectionSchema, ['properties', 'source', 'enum']), 'detector-source enum')
);

const offsetUnit = at(detectionSchema, ['properties', 'span', 'properties', 'offsetUnit', 'const']);
if (offsetUnit !== 'UNICODE_CODE_POINT') throw new Error('Portable offset unit must remain UNICODE_CODE_POINT');

console.log('Domain enums and Unicode offset unit match canonical contracts.');
