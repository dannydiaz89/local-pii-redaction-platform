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
 * @maxItems 10000
 */
export type Detections = {
  id: string;
  entityType: EntityType;
  start: number;
  end: number;
  confidence: number;
  /**
   * @minItems 1
   */
  evidenceIds: [string, ...string[]];
}[];
/**
 * @maxItems 10000
 */
export type Conflicts = {
  code: 'INCOMPATIBLE_OVERLAP';
  /**
   * @minItems 2
   */
  evidenceIds: [string, string, ...string[]];
  start: number;
  end: number;
}[];

/**
 * Privacy-minimized scan result bound to an external policy digest without disclosing selectors or paths.
 */
export interface PolicyBoundCLIScanReportV2 {
  schemaVersion: '2.0.0';
  operation: 'SCAN';
  outcome: 'SUCCEEDED' | 'NEEDS_REVIEW';
  input: ArtifactSummary;
  policy: PolicySummary;
  detectorBundleVersion: string;
  counts: Counts;
  detections: Detections;
  conflicts: Conflicts;
}
export interface ArtifactSummary {
  displayName?: string;
  mediaType?:
    | 'text/plain'
    | 'text/markdown'
    | 'application/json'
    | 'text/csv'
    | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    | 'application/pdf';
  byteLength: number;
  digest: string;
  extractionRevision?: string;
  unicodeCodePoints?: number;
  hasUtf8Bom?: boolean;
}
/**
 * This interface was referenced by `PolicyBoundCLIScanReportV2`'s JSON-Schema
 * via the `definition` "policySummary".
 */
export interface PolicySummary {
  id: string;
  version: string;
  digest: string;
  riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  example: false;
}
export interface Counts {
  detections: number;
  conflicts: number;
  byEntity: {
    [k: string]: number;
  };
}
