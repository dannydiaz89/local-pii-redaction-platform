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
 * A bounded, value-free detection list from an authenticated process-local browser preview scan.
 */
export interface EphemeralPreviewReviewReport {
  schemaVersion: '1.0.0';
  operation: 'SCAN';
  outcome: 'SUCCEEDED' | 'NEEDS_REVIEW';
  counts: {
    detections: number;
    conflicts: number;
    byEntity: {
      [k: string]: number;
    };
  };
  /**
   * @maxItems 100
   */
  detections: {
    entityType: EntityType;
    start: number;
    end: number;
    offsetUnit: 'UNICODE_CODE_POINT';
    confidence: number;
    /**
     * @minItems 1
     * @maxItems 6
     */
    sources:
      | ['REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL']
      | [
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL'
        ]
      | [
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL'
        ]
      | [
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL'
        ]
      | [
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL'
        ]
      | [
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL',
          'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL'
        ];
  }[];
  detailsLimited: boolean;
}
