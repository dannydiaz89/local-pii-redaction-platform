// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Privacy-minimized machine output for local scan, redact, verify, and inspect commands.
 */
export type CLIOperationReport = {
  [k: string]: unknown;
} & {
  schemaVersion: '1.0.0';
  operation: 'SCAN' | 'REDACT' | 'VERIFY' | 'INSPECT';
  outcome: 'SUCCEEDED' | 'NEEDS_REVIEW' | 'VERIFIED' | 'PASS' | 'FAIL';
  input?: ArtifactSummary;
  output?: ArtifactSummary;
  artifact?: ArtifactSummary;
  policy?: PolicySummary;
  detectorBundleVersion?: string;
  counts?: {
    detections: number;
    conflicts: number;
    byEntity: {
      [k: string]: number;
    };
  };
  /**
   * @maxItems 10000
   */
  detections?: {
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
  conflicts?: {
    code: 'INCOMPATIBLE_OVERLAP';
    /**
     * @minItems 2
     */
    evidenceIds: [string, string, ...string[]];
    start: number;
    end: number;
  }[];
  plan?: {
    id: string;
    digest: string;
    inputDigest: string;
    extractionRevision: string;
    resolutionDigest: string;
    capabilityDigest: string;
    policyDigest: string;
    detectorBundleVersion: string;
    writer: {
      id: string;
      version: string;
    };
    strategy: 'TYPED_LABEL';
    strategyVersion: string;
    actionCount: number;
    byEntity: {
      [k: string]: number;
    };
  };
  writerReceipt?: WriterReceiptSummary;
  verification?: Verification;
  capability?: {
    adapter: 'text';
    version: string;
    operations: ('SCAN' | 'REDACT' | 'VERIFY' | 'INSPECT')[];
  };
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
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "artifactSummary".
 */
export interface ArtifactSummary {
  displayName?: string;
  mediaType?: 'text/plain' | 'text/markdown';
  byteLength: number;
  digest: string;
  extractionRevision?: string;
  unicodeCodePoints?: number;
  hasUtf8Bom?: boolean;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "policySummary".
 */
export interface PolicySummary {
  id: string;
  version: string;
  digest: string;
  riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  example: true;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "writerReceiptSummary".
 */
export interface WriterReceiptSummary {
  receiptDigest: string;
  planDigest: string;
  outputDigest: string;
  writer: {
    id: string;
    version: string;
  };
  expectedActionCount: number;
  appliedActionCount: number;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "verification".
 */
export interface Verification {
  schemaVersion: '1.0.0';
  profile: 'text-rescan-v1';
  outcome: 'PASS' | 'FAIL';
  detectorBundleVersion: string;
  /**
   * @minItems 3
   */
  checks: [
    'UTF8_REOPEN' | 'DETERMINISTIC_RESCAN' | 'SPAN_RESOLUTION',
    'UTF8_REOPEN' | 'DETERMINISTIC_RESCAN' | 'SPAN_RESOLUTION',
    'UTF8_REOPEN' | 'DETERMINISTIC_RESCAN' | 'SPAN_RESOLUTION',
    ...('UTF8_REOPEN' | 'DETERMINISTIC_RESCAN' | 'SPAN_RESOLUTION')[]
  ];
  /**
   * @maxItems 10000
   */
  findings: {
    code: 'RESIDUAL_DETECTION' | 'SPAN_CONFLICT';
    severity: 'ERROR';
    blocking: true;
    entityType?: EntityType;
    start?: number;
    end?: number;
  }[];
}
