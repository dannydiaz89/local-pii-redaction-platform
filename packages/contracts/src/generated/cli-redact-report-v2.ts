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
 * Privacy-minimized redaction result bound to a canonical verification attestation v2.
 */
export interface CLIRedactionReportV2 {
  schemaVersion: '2.0.0';
  operation: 'REDACT';
  outcome: 'VERIFIED';
  input: ArtifactSummary;
  output: ArtifactSummary;
  policy: PolicySummary;
  plan: Plan;
  writerReceipt: WriterReceiptSummary;
  verification: VerificationAttestationV2;
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
export interface PolicySummary {
  id: string;
  version: string;
  digest: string;
  riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  example: true;
}
export interface Plan {
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
}
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
 * Privacy-safe independent verification attestation bound to the exact input, staged output, immutable plan, policy, writer receipt, and verifier provenance. Paths, clear values, and action identifiers are intentionally excluded.
 */
export interface VerificationAttestationV2 {
  schemaVersion: '2.0.0';
  /**
   * Exact source bytes bound to the immutable plan.
   */
  input: {
    digest: string;
    byteLength: number;
  };
  /**
   * Exact derived bytes independently reopened and verified before publication.
   */
  output: {
    digest: string;
    byteLength: number;
    mediaType: string;
    extractionRevision: string;
  };
  /**
   * Identity and digest of the immutable plan applied to the input.
   */
  plan: {
    id: string;
    digest: string;
  };
  /**
   * Exact policy provenance used to compile the immutable plan.
   */
  policy: {
    id: string;
    version: string;
    digest: string;
    riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  };
  capabilityDigest: string;
  writerReceiptDigest: string;
  /**
   * Versioned verification-profile identity.
   */
  profile: {
    id: string;
    version: string;
    digest: string;
  };
  /**
   * Versioned verifier implementation identity.
   */
  verifier: {
    id: string;
    version: string;
    digest: string;
  };
  detectorBundle: Component;
  writer: Component;
  application: Component;
  outcome: 'PASS' | 'FAIL' | 'INCOMPLETE';
  /**
   * Closed set of required checks completed by the profile. Action reconciliation is mandatory for every v2 attestation.
   *
   * @minItems 1
   * @maxItems 7
   */
  checks:
    | [
        | 'UTF8_REOPEN'
        | 'DETERMINISTIC_RESCAN'
        | 'SPAN_RESOLUTION'
        | 'ACTION_RECONCILIATION'
        | 'NATIVE_SURFACE'
        | 'STRUCTURE'
        | 'FIDELITY'
      ]
    | [
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        )
      ]
    | [
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        )
      ]
    | [
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        )
      ]
    | [
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        )
      ]
    | [
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        )
      ]
    | [
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        ),
        (
          | 'UTF8_REOPEN'
          | 'DETERMINISTIC_RESCAN'
          | 'SPAN_RESOLUTION'
          | 'ACTION_RECONCILIATION'
          | 'NATIVE_SURFACE'
          | 'STRUCTURE'
          | 'FIDELITY'
        )
      ];
  /**
   * Bounded aggregate comparison of the immutable plan and writer receipt; no action identifiers are retained.
   */
  reconciliation: {
    expectedActionCount: number;
    appliedActionCount: number;
    missingActionCount: number;
    unexpectedActionCount: number;
    duplicateActionCount: number;
  };
  /**
   * Privacy-safe bounded findings without values, paths, locations, or action identifiers.
   *
   * @maxItems 1000
   */
  findings: {
    code:
      | 'RESIDUAL_ENTITY'
      | 'ACTION_NOT_APPLIED'
      | 'UNEXPECTED_ACTION'
      | 'DUPLICATE_ACTION'
      | 'HIDDEN_TEXT_PRESENT'
      | 'METADATA_RESIDUAL'
      | 'EMBEDDED_CONTENT_UNCHECKED'
      | 'OVERLAY_WITH_UNDERLYING_TEXT'
      | 'STRUCTURE_INVALID'
      | 'FIDELITY_OUT_OF_RANGE'
      | 'REOPEN_FAILED'
      | 'OUTPUT_DIGEST_MISMATCH'
      | 'VERIFIER_INCOMPLETE';
    severity: 'ERROR' | 'CRITICAL';
    blocking: true;
    check:
      | 'UTF8_REOPEN'
      | 'DETERMINISTIC_RESCAN'
      | 'SPAN_RESOLUTION'
      | 'ACTION_RECONCILIATION'
      | 'NATIVE_SURFACE'
      | 'STRUCTURE'
      | 'FIDELITY';
    entityType?: EntityType;
    count?: number;
  }[];
  startedAt: string;
  completedAt: string;
  reportDigest: string;
}
/**
 * This interface was referenced by `VerificationAttestationV2`'s JSON-Schema
 * via the `definition` "component".
 */
export interface Component {
  id: string;
  version: string;
  digest: string;
}
