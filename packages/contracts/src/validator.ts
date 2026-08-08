import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { schemaCatalog } from './generated/schema-catalog.js';

export interface ContractValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
ajv.addFormat('date-time', (value: string) => !Number.isNaN(Date.parse(value)));
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
