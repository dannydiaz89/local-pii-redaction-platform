// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Privacy-safe stable error envelope with explicit artifact-integrity and cooperative-cancellation classifications.
 */
export interface TypedErrorEnvelopeV3 {
  schemaVersion: '3.0.0';
  error: {
    code:
      | 'CONTRACT_UNSUPPORTED'
      | 'SCHEMA_INVALID'
      | 'IDEMPOTENCY_CONFLICT'
      | 'INPUT_TOO_LARGE'
      | 'FORMAT_UNSUPPORTED'
      | 'FORMAT_ENCRYPTED'
      | 'FORMAT_CORRUPT'
      | 'POLICY_UNSATISFIABLE'
      | 'POLICY_REVIEW_REQUIRED'
      | 'POLICY_BLOCKED'
      | 'REQUIRED_DETECTOR_UNAVAILABLE'
      | 'MODEL_UNAVAILABLE'
      | 'DETECTOR_TIMEOUT'
      | 'DETECTION_LIMIT_EXCEEDED'
      | 'MODEL_OUTPUT_INVALID'
      | 'SOURCE_MAP_INVALID'
      | 'REDACTION_PLAN_CONFLICT'
      | 'REDACTION_COUNT_MISMATCH'
      | 'VERIFICATION_RESIDUAL'
      | 'VERIFICATION_INCOMPLETE'
      | 'FIDELITY_OUT_OF_RANGE'
      | 'ARTIFACT_DIGEST_MISMATCH'
      | 'STORAGE_UNAVAILABLE'
      | 'JOB_CONFLICT'
      | 'OUTPUT_COLLISION'
      | 'RATE_LIMITED'
      | 'SUPPLY_CHAIN_INVALID'
      | 'AUTHORIZATION_DENIED'
      | 'OPERATION_CANCELLED'
      | 'INTERNAL_ERROR';
    message: string;
    retryable: boolean;
    correlationId: string;
    /**
     * Allow-listed safe scalar context; never paths, excerpts, or parser exceptions.
     */
    details?: {
      [k: string]: string | number | boolean | null;
    };
  };
}
