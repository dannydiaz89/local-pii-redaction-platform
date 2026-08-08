export const errorCodes = [
  'CONTRACT_UNSUPPORTED', 'SCHEMA_INVALID', 'IDEMPOTENCY_CONFLICT',
  'INPUT_TOO_LARGE', 'FORMAT_UNSUPPORTED', 'FORMAT_ENCRYPTED', 'FORMAT_CORRUPT',
  'POLICY_UNSATISFIABLE', 'REQUIRED_DETECTOR_UNAVAILABLE', 'MODEL_UNAVAILABLE',
  'DETECTOR_TIMEOUT', 'DETECTION_LIMIT_EXCEEDED', 'MODEL_OUTPUT_INVALID',
  'SOURCE_MAP_INVALID', 'REDACTION_PLAN_CONFLICT', 'REDACTION_COUNT_MISMATCH',
  'VERIFICATION_RESIDUAL', 'VERIFICATION_INCOMPLETE', 'FIDELITY_OUT_OF_RANGE',
  'STORAGE_UNAVAILABLE', 'JOB_CONFLICT', 'OUTPUT_COLLISION', 'RATE_LIMITED',
  'SUPPLY_CHAIN_INVALID', 'AUTHORIZATION_DENIED', 'INTERNAL_ERROR'
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export interface SafeErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export class SafeError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly correlationId: string;
  public readonly details: Readonly<Record<string, string | number | boolean | null>> | undefined;

  public constructor(options: SafeErrorOptions) {
    super(options.message);
    this.name = 'SafeError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.correlationId = options.correlationId;
    this.details = options.details;
  }
}
