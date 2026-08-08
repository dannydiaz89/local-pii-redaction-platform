import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { schemaCatalog } from './generated/schema-catalog.js';
import { isCanonicalUuid, isRfc3339DateTime } from './formats.js';

export interface ContractValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
ajv.addFormat('uuid', isCanonicalUuid);
ajv.addFormat('date-time', isRfc3339DateTime);
ajv.addFormat('uri', (value: string) => {
  try { return new URL(value).protocol.length > 1; } catch { return false; }
});
ajv.addKeyword({ keyword: 'schemaVersion', schemaType: 'string', valid: true });

for (const schema of schemaCatalog) {
  ajv.addSchema(schema);
}

export function validateContract(schemaId: string, value: unknown): ContractValidationResult {
  const validator: ValidateFunction | undefined = ajv.getSchema(schemaId);
  if (validator === undefined) {
    throw new Error(`Unknown contract schema: ${schemaId}`);
  }

  const valid = validator(value);
  return { valid, errors: validator.errors ?? [] };
}

export function assertContract(schemaId: string, value: unknown): void {
  const result = validateContract(schemaId, value);
  if (!result.valid) {
    const summary = result.errors.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
    throw new Error(`Contract validation failed for ${schemaId}: ${summary}`);
  }
}
