// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * This interface was referenced by `ReviewSet`'s JSON-Schema
 * via the `definition` "DecisionRecord".
 */
export type DecisionRecord =
  | {
      revision: number;
      clientDecisionId: string;
      targetDetectionId: string;
      action: 'ACCEPT';
      reasonCode: 'CONFIRMED_BY_REVIEWER';
      principal: 'LOCAL_SESSION';
      occurredAt: string;
    }
  | {
      revision: number;
      clientDecisionId: string;
      targetDetectionId: string;
      action: 'REJECT';
      reasonCode: 'FALSE_POSITIVE';
      principal: 'LOCAL_SESSION';
      occurredAt: string;
    }
  | {
      revision: number;
      clientDecisionId: string;
      targetDetectionId: string;
      action: 'RETYPE';
      entityType: EntityType;
      reasonCode: 'INCORRECT_ENTITY_TYPE';
      principal: 'LOCAL_SESSION';
      occurredAt: string;
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
 * A bounded append-only, value-free review history bound to one scan and extraction revision.
 */
export interface ReviewSet {
  schemaVersion: '1.0.0';
  jobId: string;
  jobRevision: number;
  extractionRevision: string;
  reviewRevision: number;
  digest: string;
  /**
   * @maxItems 1000
   */
  decisions: DecisionRecord[];
}
