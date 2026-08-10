// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * This interface was referenced by `AppendReviewDecisionsRequest`'s JSON-Schema
 * via the `definition` "Decision".
 */
export type Decision =
  | {
      clientDecisionId: string;
      targetDetectionId: string;
      action: 'ACCEPT';
      reasonCode: 'CONFIRMED_BY_REVIEWER';
    }
  | {
      clientDecisionId: string;
      targetDetectionId: string;
      action: 'REJECT';
      reasonCode: 'FALSE_POSITIVE';
    }
  | {
      clientDecisionId: string;
      targetDetectionId: string;
      action: 'RETYPE';
      entityType: EntityType;
      reasonCode: 'INCORRECT_ENTITY_TYPE';
    };
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
 * A bounded optimistic-concurrency batch of value-free reviewer decisions for one scan result.
 */
export interface AppendReviewDecisionsRequest {
  schemaVersion: '1.0.0';
  expectedJobRevision: number;
  expectedExtractionRevision: string;
  expectedReviewRevision: number;
  /**
   * @minItems 1
   * @maxItems 100
   */
  decisions: [Decision, ...Decision[]];
}
