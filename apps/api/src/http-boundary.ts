import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  validateContract,
  type CommonErrorsContract,
  type CommonErrorsV2Contract,
  type CommonErrorsV3Contract
} from '@local-pii/contracts';
import { SafeError } from '@local-pii/domain';

import { apiContractIds } from './contract-ids.js';
import type { PreviewFormat } from './preview-scan.js';

type ErrorEnvelope = CommonErrorsContract.TypedErrorEnvelope
  | CommonErrorsV2Contract.TypedErrorEnvelopeV2
  | CommonErrorsV3Contract.TypedErrorEnvelopeV3;

const idempotencyKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const jobIdPattern = /^job_[0-9A-HJKMNP-TV-Z]{26}$/u;
const artifactIdPattern = /^art_[0-9A-HJKMNP-TV-Z]{26}$/u;

export class HttpSafeError extends SafeError {
  public readonly httpStatusCode: number;

  public constructor(statusCode: number, options: ConstructorParameters<typeof SafeError>[0]) {
    super(options);
    this.httpStatusCode = statusCode;
  }
}

export function requestCorrelationId(request: FastifyRequest): string {
  return `cor_http_${request.id}`.slice(0, 128);
}

export function safeError(error: unknown, correlationId: string): SafeError {
  if (error instanceof SafeError) return error;
  const statusCode = error instanceof Error && 'statusCode' in error
    ? (error as Error & { readonly statusCode?: unknown }).statusCode
    : undefined;
  if (statusCode === 413) {
    return new SafeError({
      code: 'INPUT_TOO_LARGE',
      message: 'The request exceeds the configured byte limit.',
      retryable: false,
      correlationId
    });
  }
  if (statusCode === 415) {
    return new SafeError({
      code: 'FORMAT_UNSUPPORTED',
      message: 'The request content type is unsupported.',
      retryable: false,
      correlationId
    });
  }
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return new SafeError({
      code: 'SCHEMA_INVALID',
      message: 'The request is malformed or does not match its contract.',
      retryable: false,
      correlationId
    });
  }
  return new SafeError({
    code: 'INTERNAL_ERROR',
    message: 'The HTTP operation failed unexpectedly.',
    retryable: false,
    correlationId
  });
}

export function statusFor(error: SafeError): number {
  if (error instanceof HttpSafeError) return error.httpStatusCode;
  if (error.code === 'OPERATION_CANCELLED') return 408;
  if (error.code === 'INPUT_TOO_LARGE') return 413;
  if (error.code === 'FORMAT_CORRUPT') return 422;
  if (error.code === 'FORMAT_UNSUPPORTED') return 415;
  if (error.code === 'ARTIFACT_DIGEST_MISMATCH') return 409;
  if (error.code === 'POLICY_UNSATISFIABLE') return 422;
  if (error.code === 'AUTHORIZATION_DENIED') return 403;
  if (error.code === 'IDEMPOTENCY_CONFLICT' || error.code === 'JOB_CONFLICT') return 409;
  if (error.code === 'RATE_LIMITED') return 429;
  if (error.code === 'MODEL_UNAVAILABLE' || error.code === 'STORAGE_UNAVAILABLE') return 503;
  if (error.code === 'SCHEMA_INVALID' || error.code === 'CONTRACT_UNSUPPORTED') return 400;
  return 500;
}

function errorEnvelope(error: SafeError): ErrorEnvelope {
  if (error.code === 'OPERATION_CANCELLED') {
    return {
      schemaVersion: '3.0.0',
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        correlationId: error.correlationId,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    };
  }
  if (error.code === 'ARTIFACT_DIGEST_MISMATCH') {
    return {
      schemaVersion: '2.0.0',
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        correlationId: error.correlationId,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    };
  }
  return {
    schemaVersion: '1.0.0',
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      correlationId: error.correlationId,
      ...(error.details === undefined ? {} : { details: error.details })
    }
  };
}

export function sendError(reply: FastifyReply, statusCode: number, error: SafeError): void {
  const envelope = errorEnvelope(error);
  const schemaId = envelope.schemaVersion === '3.0.0'
    ? apiContractIds.errorV3
    : envelope.schemaVersion === '2.0.0'
      ? apiContractIds.errorV2
      : apiContractIds.error;
  if (!validateContract(schemaId, envelope).valid) {
    reply.status(500).send({
      schemaVersion: '1.0.0',
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The HTTP error boundary failed.',
        retryable: false,
        correlationId: 'cor_http_error_boundary'
      }
    } satisfies ErrorEnvelope);
    return;
  }
  reply.status(statusCode).send(envelope);
}

export function sendCanonical(reply: FastifyReply, schemaId: string, value: unknown): FastifyReply {
  if (!validateContract(schemaId, value).valid) {
    throw new SafeError({
      code: 'INTERNAL_ERROR',
      message: 'The application produced an invalid response.',
      retryable: false,
      correlationId: requestCorrelationId(reply.request)
    });
  }
  return reply.send(value);
}

export function requestFailure(request: FastifyRequest): HttpSafeError {
  return new HttpSafeError(400, {
    code: 'SCHEMA_INVALID',
    message: 'The request is malformed or does not match its contract.',
    retryable: false,
    correlationId: requestCorrelationId(request)
  });
}

export function canonicalBody(request: FastifyRequest, schemaId: string): unknown {
  if (!validateContract(schemaId, request.body).valid) throw requestFailure(request);
  return request.body;
}

function exactParameter(request: FastifyRequest, name: string, pattern: RegExp): string {
  const params = request.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw requestFailure(request);
  const record = params as Record<string, unknown>;
  const value = record[name];
  if (Object.keys(record).length !== 1 || typeof value !== 'string' || !pattern.test(value)) {
    throw requestFailure(request);
  }
  return value;
}

export function jobIdParameter(request: FastifyRequest): string {
  return exactParameter(request, 'jobId', jobIdPattern);
}

export function artifactIdParameter(request: FastifyRequest): string {
  return exactParameter(request, 'artifactId', artifactIdPattern);
}

function parseBoundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function queryRecord(request: FastifyRequest, allowedKeys: readonly string[]): Record<string, unknown> {
  const query = request.query;
  if (query === null || typeof query !== 'object' || Array.isArray(query)) throw requestFailure(request);
  const record = query as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) throw requestFailure(request);
  return record;
}

export function eventQuery(request: FastifyRequest): { readonly afterCursor: number; readonly limit: number } {
  const record = queryRecord(request, ['after', 'limit']);
  const afterCursor = record.after === undefined ? 0 : parseBoundedInteger(record.after, 0, Number.MAX_SAFE_INTEGER);
  const limit = record.limit === undefined ? 100 : parseBoundedInteger(record.limit, 1, 100);
  if (afterCursor === undefined || limit === undefined) throw requestFailure(request);
  return { afterCursor, limit };
}

export function detectionQuery(request: FastifyRequest): { readonly cursor: number; readonly limit: number } {
  const record = queryRecord(request, ['cursor', 'limit']);
  const cursor = record.cursor === undefined ? 0 : parseBoundedInteger(record.cursor, 0, 10_000);
  const limit = record.limit === undefined ? 100 : parseBoundedInteger(record.limit, 1, 100);
  if (cursor === undefined || limit === undefined) throw requestFailure(request);
  return { cursor, limit };
}

export function previewFormat(request: FastifyRequest): PreviewFormat {
  const record = queryRecord(request, ['format']);
  if (Object.keys(record).length !== 1 || (record.format !== 'text' && record.format !== 'markdown')) {
    throw requestFailure(request);
  }
  return record.format;
}

export function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !idempotencyKeyPattern.test(value)) throw requestFailure(request);
  return value;
}

export function unavailableJob(request: FastifyRequest): HttpSafeError {
  return new HttpSafeError(404, {
    code: 'AUTHORIZATION_DENIED',
    message: 'The requested job is unavailable.',
    retryable: false,
    correlationId: requestCorrelationId(request)
  });
}

function deadlineFailure(request: FastifyRequest): SafeError {
  return new SafeError({
    code: 'INTERNAL_ERROR',
    message: 'The HTTP operation exceeded its bounded execution deadline.',
    retryable: true,
    correlationId: requestCorrelationId(request),
    details: { deadlineExceeded: true }
  });
}

export async function invokeBounded<Result>(
  request: FastifyRequest,
  timeoutMs: number,
  lifecycleSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<Result>
): Promise<Result> {
  const controller = new AbortController();
  let rejectCancellation: (reason: Error) => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  const abortRequest = (): void => {
    controller.abort();
    rejectCancellation(new SafeError({
      code: 'OPERATION_CANCELLED',
      message: 'The HTTP request was cancelled.',
      retryable: false,
      correlationId: requestCorrelationId(request)
    }));
  };
  const abortLifecycle = (): void => {
    controller.abort();
    rejectCancellation(new HttpSafeError(503, {
      code: 'INTERNAL_ERROR',
      message: 'The local API is shutting down.',
      retryable: true,
      correlationId: requestCorrelationId(request)
    }));
  };
  request.raw.once('aborted', abortRequest);
  if (lifecycleSignal.aborted) abortLifecycle();
  else lifecycleSignal.addEventListener('abort', abortLifecycle, { once: true });
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(deadlineFailure(request));
    }, timeoutMs);
    timeout.unref();
  });
  try {
    return await Promise.race([operation(controller.signal), deadline, cancelled]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    request.raw.off('aborted', abortRequest);
    lifecycleSignal.removeEventListener('abort', abortLifecycle);
  }
}
