// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Initial versioned PII and secret entity taxonomy proposed by the reference catalog.
 */
export type EntityType =
  | 'PERSON'
  | 'EMAIL'
  | 'PHONE'
  | 'ADDRESS'
  | 'LOCATION'
  | 'ORGANIZATION'
  | 'DATE_OF_BIRTH'
  | 'SSN'
  | 'NATIONAL_ID'
  | 'PASSPORT'
  | 'DRIVER_LICENSE'
  | 'CREDIT_CARD'
  | 'BANK_ACCOUNT'
  | 'ROUTING_NUMBER'
  | 'MEDICAL_RECORD'
  | 'HEALTH_PLAN_ID'
  | 'ACCOUNT_ID'
  | 'USERNAME'
  | 'IP_ADDRESS'
  | 'MAC_ADDRESS'
  | 'API_KEY'
  | 'ACCESS_TOKEN'
  | 'PASSWORD'
  | 'CUSTOM';

/**
 * Verified local model, tokenizer, protocol, provenance, and capability declaration.
 */
export interface ModelManifest {
  schemaVersion: '1.0.0';
  id: string;
  version: string;
  modelDigest: string;
  tokenizerDigest: string;
  runtime: string;
  /**
   * @minItems 1
   */
  protocolVersions: [string, ...string[]];
  /**
   * @minItems 1
   */
  entityTypes: [EntityType, ...EntityType[]];
  /**
   * @minItems 1
   */
  languages: [string, ...string[]];
  license: {
    spdxId: string;
    notice: string;
  };
  provenance: {
    source: string;
    retrievedAt: string;
  };
}
