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
 * Bounded server-authoritative page of value-free resolved detections for one completed scan job.
 */
export interface JobDetectionPage {
  schemaVersion: '1.0.0';
  jobId: string;
  jobRevision: number;
  total: number;
  conflicts: number;
  byEntity: {
    [k: string]: number;
  };
  cursor: number;
  nextCursor: number | null;
  /**
   * @maxItems 100
   */
  detections: {
    id: string;
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
  /**
   * @maxItems 100
   */
  conflictDetails: Items[];
  conflictDetailsLimited: boolean;
}
export interface Items {
  code: 'INCOMPATIBLE_OVERLAP';
  start: number;
  end: number;
  offsetUnit: 'UNICODE_CODE_POINT';
  /**
   * @minItems 1
   * @maxItems 24
   */
  entityTypes: [EntityType, ...EntityType[]];
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
}
