import { parseCorrelationId, type CorrelationId } from './identifiers.js';
import { unicodeCodePointLength } from './span.js';

export const errorCodes = [
  'CONTRACT_UNSUPPORTED', 'SCHEMA_INVALID', 'IDEMPOTENCY_CONFLICT',
  'INPUT_TOO_LARGE', 'FORMAT_UNSUPPORTED', 'FORMAT_ENCRYPTED', 'FORMAT_CORRUPT',
  'POLICY_UNSATISFIABLE', 'POLICY_REVIEW_REQUIRED', 'POLICY_BLOCKED',
  'REQUIRED_DETECTOR_UNAVAILABLE', 'MODEL_UNAVAILABLE',
  'DETECTOR_TIMEOUT', 'DETECTION_LIMIT_EXCEEDED', 'MODEL_OUTPUT_INVALID',
  'SOURCE_MAP_INVALID', 'REDACTION_PLAN_CONFLICT', 'REDACTION_COUNT_MISMATCH',
  'VERIFICATION_RESIDUAL', 'VERIFICATION_INCOMPLETE', 'FIDELITY_OUT_OF_RANGE',
  'STORAGE_UNAVAILABLE', 'JOB_CONFLICT', 'OUTPUT_COLLISION', 'RATE_LIMITED',
  'SUPPLY_CHAIN_INVALID', 'AUTHORIZATION_DENIED', 'INTERNAL_ERROR'
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export const safeErrorDetailKeys = [
  'format', 'stage', 'attempt', 'recovered', 'reason', 'detectorId', 'deadlineExceeded', 'modelId',
  'conflictCount', 'findingCount', 'contractVersionAvailable', 'engineModeAvailable',
  'formatAvailable', 'operationAvailable', 'qualificationSufficient', 'missingDetectorCount',
  'missingDetectorKindCount', 'missingTransformationCount', 'verificationProfileAvailable',
  'inputLimitSufficient', 'maximumInputBytes', 'actualInputBytes'
] as const;

export type SafeErrorDetailKey = (typeof safeErrorDetailKeys)[number];
export type SafeErrorDetailValue = string | number | boolean | null;
export type SafeErrorDetails = Readonly<Partial<Record<SafeErrorDetailKey, SafeErrorDetailValue>>>;

export interface SafeErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly details?: SafeErrorDetails;
}

export class SafeError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly correlationId: CorrelationId;
  public readonly details: SafeErrorDetails | undefined;

  public constructor(options: SafeErrorOptions) {
    if (!(errorCodes as readonly unknown[]).includes(options.code)) throw new TypeError('Invalid error code');
    if (typeof options.message !== 'string' || unicodeCodePointLength(options.message) < 1 || unicodeCodePointLength(options.message) > 500) {
      throw new TypeError('Invalid safe error message');
    }
    if (typeof options.retryable !== 'boolean') throw new TypeError('Invalid retryable flag');
    const correlationId = parseCorrelationId(options.correlationId);

    let details: SafeErrorDetails | undefined;
    if (options.details !== undefined) {
      const candidate: unknown = options.details;
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new TypeError('Invalid safe error details');
      }
      const entries = Object.entries(candidate);
      if (entries.length > 16) throw new TypeError('Safe error details exceed the property limit');
      for (const [key, value] of entries) {
        if (!(safeErrorDetailKeys as readonly string[]).includes(key)) {
          throw new TypeError('Safe error details contain a prohibited key');
        }
        const scalar = value === null || typeof value === 'string' || typeof value === 'boolean'
          || (typeof value === 'number' && Number.isFinite(value));
        if (!scalar) throw new TypeError('Safe error details must contain JSON scalar values');
        if (typeof value === 'string' && unicodeCodePointLength(value) > 128) {
          throw new TypeError('Safe error detail string exceeds the length limit');
        }
      }
      details = Object.freeze(Object.fromEntries(entries));
    }

    super(options.message);
    this.name = 'SafeError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.correlationId = correlationId;
    this.details = details;
  }
}
