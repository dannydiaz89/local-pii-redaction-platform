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
 * Immutable ordered replacement instructions bound to exact extraction and policy digests.
 */
export interface RedactionPlan {
  schemaVersion: '1.0.0';
  id: string;
  extractionRevision: string;
  resolutionDigest: string;
  policyDigest: string;
  writer: {
    id: string;
    version: string;
  };
  /**
   * @maxItems 100000
   */
  actions: {
    id: string;
    entityType: EntityType;
    start: number;
    end: number;
    action: 'REDACT' | 'TYPED_LABEL' | 'MASK' | 'PSEUDONYM' | 'HASHED_LABEL';
    replacement: string;
  }[];
  digest: string;
}
