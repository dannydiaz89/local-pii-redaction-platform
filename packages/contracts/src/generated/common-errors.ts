// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Privacy-safe stable error returned at process and protocol boundaries.
 */
export interface TypedErrorEnvelope {
  schemaVersion: '1.0.0';
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
      | 'STORAGE_UNAVAILABLE'
      | 'JOB_CONFLICT'
      | 'OUTPUT_COLLISION'
      | 'RATE_LIMITED'
      | 'SUPPLY_CHAIN_INVALID'
      | 'AUTHORIZATION_DENIED'
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
