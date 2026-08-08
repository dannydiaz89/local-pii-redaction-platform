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
 * Contextual candidate spans relative to request chunks plus immutable model provenance.
 */
export interface InferenceDetectResponse {
  schemaVersion: '1.0.0';
  requestId: string;
  /**
   * @maxItems 64000
   */
  detections: {
    chunkId: string;
    entityType: EntityType;
    start: number;
    end: number;
    confidence: number;
    detector: {
      id: string;
      version: string;
    };
  }[];
  model: {
    id: string;
    version: string;
    digest: string;
    runtime: string;
  };
  /**
   * @maxItems 100
   */
  warnings: string[];
}
