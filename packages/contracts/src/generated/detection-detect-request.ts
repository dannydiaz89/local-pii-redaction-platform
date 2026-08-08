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
 * Bounded contextual-inference request containing opaque chunks and no artifact metadata.
 */
export interface InferenceDetectRequest {
  schemaVersion: '1.0.0';
  requestId: string;
  /**
   * @minItems 1
   * @maxItems 64
   */
  chunks: [
    {
      id: string;
      text: string;
      absoluteStart: number;
      language?: string;
    },
    ...{
      id: string;
      text: string;
      absoluteStart: number;
      language?: string;
    }[]
  ];
  /**
   * @minItems 1
   */
  entityTypes: [EntityType, ...EntityType[]];
  minimumConfidence: number;
  options: {
    maxDetectionsPerChunk: number;
  };
}
