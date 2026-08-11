import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { schemaCatalog } from './generated/schema-catalog.js';
import { isCanonicalUuid, isRfc3339DateTime } from './formats.js';
import { batchScanReportSchemaIds, batchScanReportSemanticErrors } from './batch-scan-report.js';

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
  const schemaErrors = validator.errors ?? [];
  if (!valid || !batchScanReportSchemaIds.has(schemaId)) return { valid, errors: schemaErrors };
  const semanticErrors = batchScanReportSemanticErrors(
    value as Parameters<typeof batchScanReportSemanticErrors>[0]
  );
  if (semanticErrors.length === 0) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: semanticErrors.map((message): ErrorObject => ({
      keyword: 'batchScanSemantics',
      instancePath: '/manifest',
      schemaPath: '#/x-batchScanSemantics',
      params: {},
      message
    }))
  };
}

export function assertContract(schemaId: string, value: unknown): void {
  const result = validateContract(schemaId, value);
  if (!result.valid) {
    const summary = result.errors.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
    throw new Error(`Contract validation failed for ${schemaId}: ${summary}`);
  }
}
