import { createHash, timingSafeEqual } from 'node:crypto';

import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from 'fastify';

import {
  localPreviewMaximumInputBytes,
  validateContract,
  type CapabilitiesCapabilityManifestContract,
  type CommonErrorsContract,
  type CommonErrorsV2Contract,
  type CommonErrorsV3Contract,
  type PolicyPolicyCatalogContract
} from '@local-pii/contracts';
import type { ApplicationContext } from '@local-pii/core';
import { SafeError } from '@local-pii/domain';

import type { CancelJobRequest, CreateJobRequest, JobControlPort } from './job-control.js';
import type { PreviewFormat, PreviewScanPort } from './preview-scan.js';
import {
  isLocalWebShellRoute,
  registerLocalWebShell,
  type LocalWebShellOptions
} from './web-shell.js';

export type CapabilityManifest = CapabilitiesCapabilityManifestContract.CapabilityManifest;
type GeneratedPolicyCatalog = PolicyPolicyCatalogContract.PolicyCatalog;
type PolicyReference = Readonly<GeneratedPolicyCatalog['policies'][number]>;
export type PolicyCatalog = Readonly<Omit<GeneratedPolicyCatalog, 'policies'>> & {
  readonly policies: readonly [PolicyReference, ...PolicyReference[]];
};
type ErrorEnvelope = CommonErrorsContract.TypedErrorEnvelope
  | CommonErrorsV2Contract.TypedErrorEnvelopeV2
  | CommonErrorsV3Contract.TypedErrorEnvelopeV3;

export interface CapabilityApplicationPort {
  getCapabilities(context: ApplicationContext, signal?: AbortSignal): Promise<CapabilityManifest>;
}

export interface ApiReadinessPort {
  check(signal?: AbortSignal): Promise<void>;
}

export interface PolicyCatalogPort {
  get(signal?: AbortSignal): Promise<PolicyCatalog>;
}

export interface ApiDependencies {
  readonly application: CapabilityApplicationPort;
  readonly jobs: JobControlPort;
  readonly policies: PolicyCatalogPort;
  readonly preview: PreviewScanPort;
  readonly readiness: ApiReadinessPort;
}

export interface LocalSessionPolicy {
  /** An opaque, per-launch secret. It is never logged or included in an error response. */
  readonly bearerToken: string;
  /** Exact numeric-loopback browser origins authorized to read API responses. */
  readonly allowedOrigins?: readonly string[];
}

export interface BuildApiOptions {
  readonly session: LocalSessionPolicy;
  readonly handlerTimeoutMs?: number;
  readonly browserShell?: LocalWebShellOptions;
}

export const apiMaximumBodyBytes = 16 * 1024;
export const apiDefaultHandlerTimeoutMs = 5_000;

const capabilitySchemaId = 'https://local-pii.dev/schemas/capabilities/capability-manifest/1.0.0';
const cancelJobRequestSchemaId = 'https://local-pii.dev/schemas/jobs/cancel-job-request/1.0.0';
const createJobRequestSchemaId = 'https://local-pii.dev/schemas/jobs/create-job-request/1.0.0';
const errorSchemaId = 'https://local-pii.dev/schemas/common/errors/1.0.0';
const errorSchemaV2Id = 'https://local-pii.dev/schemas/common/errors/2.0.0';
const errorSchemaV3Id = 'https://local-pii.dev/schemas/common/errors/3.0.0';
const jobEventPageSchemaId = 'https://local-pii.dev/schemas/jobs/job-event-page/1.0.0';
const jobSchemaId = 'https://local-pii.dev/schemas/jobs/job/1.0.0';
const policyCatalogSchemaId = 'https://local-pii.dev/schemas/policy/policy-catalog/1.0.0';
const previewScanSchemaId = 'https://local-pii.dev/schemas/jobs/preview-scan-report/1.0.0';
const previewReviewSchemaId = 'https://local-pii.dev/schemas/jobs/preview-review-report/2.0.0';
const tokenPattern = /^[A-Za-z0-9_-]{43,128}$/u;
const idempotencyKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const jobIdPattern = /^job_[0-9A-HJKMNP-TV-Z]{26}$/u;

class HttpSafeError extends SafeError {
  public readonly httpStatusCode: number;

  public constructor(statusCode: number, options: ConstructorParameters<typeof SafeError>[0]) {
    super(options);
    this.httpStatusCode = statusCode;
  }
}

function requestCorrelationId(request: FastifyRequest): string {
  return `cor_http_${request.id}`.slice(0, 128);
}

function validateSessionPolicy(policy: LocalSessionPolicy): ReadonlySet<string> {
  if (!tokenPattern.test(policy.bearerToken)) {
    throw new TypeError('The local API session token does not meet the required format.');
  }
  const origins = new Set<string>();
  for (const candidate of policy.allowedOrigins ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new TypeError('A local API browser origin is invalid.');
    }
    if (
      parsed.protocol !== 'http:'
      || parsed.hostname !== '127.0.0.1'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
      || parsed.origin !== candidate
    ) {
      throw new TypeError('Local API browser origins must be exact numeric-loopback HTTP origins.');
    }
    origins.add(candidate);
  }
  return origins;
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length);
  return token.length > 0 && !token.includes(' ') ? token : undefined;
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function authorizationFailure(request: FastifyRequest): HttpSafeError {
  return new HttpSafeError(401, {
    code: 'AUTHORIZATION_DENIED',
    message: 'A valid local API session is required.',
    retryable: false,
    correlationId: requestCorrelationId(request)
  });
}

function originFailure(request: FastifyRequest): HttpSafeError {
  return new HttpSafeError(403, {
    code: 'AUTHORIZATION_DENIED',
    message: 'The browser origin is not authorized for this local API.',
    retryable: false,
    correlationId: requestCorrelationId(request)
  });
}

function authorityFailure(request: FastifyRequest): HttpSafeError {
  return new HttpSafeError(403, {
    code: 'AUTHORIZATION_DENIED',
    message: 'The request authority is not authorized for this local API.',
    retryable: false,
    correlationId: requestCorrelationId(request)
  });
}

function isNumericLoopbackAuthority(host: string | undefined): boolean {
  if (host === undefined) return false;
  const match = /^127\.0\.0\.1(?::([0-9]{1,5}))?$/u.exec(host);
  if (match === null) return false;
  const port = match[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
}

function safeError(error: unknown, correlationId: string): SafeError {
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

function statusFor(error: SafeError): number {
  if (error instanceof HttpSafeError) return error.httpStatusCode;
  if (error.code === 'OPERATION_CANCELLED') return 408;
  if (error.code === 'INPUT_TOO_LARGE') return 413;
  if (error.code === 'FORMAT_CORRUPT') return 422;
  if (error.code === 'FORMAT_UNSUPPORTED') return 415;
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

function sendError(reply: FastifyReply, statusCode: number, error: SafeError): void {
  const envelope = errorEnvelope(error);
  const envelopeSchemaId = envelope.schemaVersion === '3.0.0'
    ? errorSchemaV3Id
    : envelope.schemaVersion === '2.0.0'
      ? errorSchemaV2Id
      : errorSchemaId;
  if (!validateContract(envelopeSchemaId, envelope).valid) {
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

function sendCanonical(reply: FastifyReply, schemaId: string, value: unknown): FastifyReply {
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

function requestFailure(request: FastifyRequest): HttpSafeError {
  return new HttpSafeError(400, {
    code: 'SCHEMA_INVALID',
    message: 'The request is malformed or does not match its contract.',
    retryable: false,
    correlationId: requestCorrelationId(request)
  });
}

function canonicalBody(request: FastifyRequest, schemaId: string): unknown {
  if (!validateContract(schemaId, request.body).valid) throw requestFailure(request);
  return request.body;
}

function jobIdParameter(request: FastifyRequest): string {
  const params = request.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw requestFailure(request);
  const record = params as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.jobId !== 'string' || !jobIdPattern.test(record.jobId)) {
    throw requestFailure(request);
  }
  return record.jobId;
}

function parseBoundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function eventQuery(request: FastifyRequest): { readonly afterCursor: number; readonly limit: number } {
  const query = request.query;
  if (query === null || typeof query !== 'object' || Array.isArray(query)) throw requestFailure(request);
  const record = query as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'after' && key !== 'limit')) throw requestFailure(request);
  const afterCursor = record.after === undefined ? 0 : parseBoundedInteger(record.after, 0, Number.MAX_SAFE_INTEGER);
  const limit = record.limit === undefined ? 100 : parseBoundedInteger(record.limit, 1, 100);
  if (afterCursor === undefined || limit === undefined) throw requestFailure(request);
  return { afterCursor, limit };
}

function previewFormat(request: FastifyRequest): PreviewFormat {
  const query = request.query;
  if (query === null || typeof query !== 'object' || Array.isArray(query)) throw requestFailure(request);
  const record = query as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || (record.format !== 'text' && record.format !== 'markdown')) {
    throw requestFailure(request);
  }
  return record.format;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !idempotencyKeyPattern.test(value)) throw requestFailure(request);
  return value;
}

function unavailableJob(request: FastifyRequest): HttpSafeError {
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

async function invokeBounded<Result>(
  request: FastifyRequest,
  timeoutMs: number,
  lifecycleSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<Result>
): Promise<Result> {
  const controller = new AbortController();
  let rejectCancellation: (reason: Error) => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
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

function setCorsHeaders(reply: FastifyReply, origin: string): void {
  reply.header('access-control-allow-origin', origin);
  reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
  reply.header('access-control-allow-headers', 'authorization, content-type, idempotency-key');
  reply.header('access-control-max-age', '300');
  reply.header('vary', 'Origin');
}

function requestedHeadersAreAllowed(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return true;
  const allowed = new Set(['authorization', 'content-type', 'idempotency-key']);
  return value.split(',').every((header) => allowed.has(header.trim().toLowerCase()));
}

export function buildApi(dependencies: ApiDependencies, options: BuildApiOptions): FastifyInstance {
  const allowedOrigins = validateSessionPolicy(options.session);
  const jobIdempotencyScope = `session-${createHash('sha256').update(options.session.bearerToken, 'utf8').digest('hex')}`;
  const lifecycle = new AbortController();
  const activePreviewRequests = new WeakSet<FastifyRequest>();
  let previewActive = false;
  const handlerTimeoutMs = options.handlerTimeoutMs ?? apiDefaultHandlerTimeoutMs;
  if (!Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs < 100 || handlerTimeoutMs > 60_000) {
    throw new TypeError('The API handler timeout is outside the supported range.');
  }

  const server = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false,
    bodyLimit: apiMaximumBodyBytes,
    connectionTimeout: 5_000,
    requestTimeout: 5_000,
    keepAliveTimeout: 5_000,
    maxRequestsPerSocket: 100,
    requestIdHeader: false,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    forceCloseConnections: true,
    return503OnClosing: true
  });

  const reservePreview = (request: FastifyRequest): void => {
    if (previewActive) {
      throw new HttpSafeError(429, {
        code: 'RATE_LIMITED',
        message: 'Another local preview scan is already running.',
        retryable: true,
        correlationId: requestCorrelationId(request)
      });
    }
    previewActive = true;
    activePreviewRequests.add(request);
  };
  const releasePreview = (request: FastifyRequest): void => {
    if (!activePreviewRequests.delete(request)) return;
    previewActive = false;
  };

  server.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => { done(null, body); }
  );

  server.setErrorHandler((error, request, reply) => {
    const mapped = safeError(error, requestCorrelationId(request));
    sendError(reply, statusFor(mapped), mapped);
  });

  server.setNotFoundHandler((request, reply) => {
    sendError(reply, 404, new HttpSafeError(404, {
      code: 'SCHEMA_INVALID',
      message: 'The requested resource is unavailable.',
      retryable: false,
      correlationId: requestCorrelationId(request)
    }));
  });

  server.addHook('preClose', () => {
    lifecycle.abort();
  });

  server.addHook('onRequest', async (request, reply) => {
    if (!isNumericLoopbackAuthority(request.headers.host)) throw authorityFailure(request);
    const origin = request.headers.origin;
    if (origin !== undefined) {
      const sameBrowserShellOrigin = options.browserShell !== undefined
        && origin === `http://${request.headers.host ?? ''}`;
      if (!allowedOrigins.has(origin) && !sameBrowserShellOrigin) throw originFailure(request);
      setCorsHeaders(reply, origin);
    }

    if (request.method === 'OPTIONS') {
      const requestedMethod = request.headers['access-control-request-method'];
      if (
        origin === undefined
        || (requestedMethod !== 'GET' && requestedMethod !== 'POST')
        || !requestedHeadersAreAllowed(request.headers['access-control-request-headers'])
      ) {
        throw originFailure(request);
      }
      return;
    }

    // Health endpoints are intentionally secret-free probes. The numeric-loopback Host and
    // browser-origin boundary still applies, and readiness discloses only ready/not-ready.
    if (request.routeOptions.url === '/health/live' || request.routeOptions.url === '/health/ready') return;
    if (options.browserShell !== undefined && isLocalWebShellRoute(request.routeOptions.url)) return;
    if (!tokenMatches(bearerToken(request.headers.authorization), options.session.bearerToken)) {
      throw authorizationFailure(request);
    }
  });

  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });

  server.options('/v1/*', (_request, reply) => reply.status(204).send());
  server.get('/health/live', (_request, reply) => reply.status(204).send());
  server.get('/health/ready', async (request, reply) => {
    try {
      await invokeBounded(request, handlerTimeoutMs, lifecycle.signal, (signal) => dependencies.readiness.check(signal));
    } catch {
      throw new HttpSafeError(503, {
        code: 'INTERNAL_ERROR',
        message: 'The local API is not ready to accept work.',
        retryable: true,
        correlationId: requestCorrelationId(request)
      });
    }
    return reply.status(204).send();
  });
  server.get('/v1/capabilities', async (request, reply) => {
    const manifest = await invokeBounded(request, handlerTimeoutMs, lifecycle.signal, (signal) =>
      dependencies.application.getCapabilities({ correlationId: requestCorrelationId(request) }, signal)
    );
    return sendCanonical(reply, capabilitySchemaId, manifest);
  });
  server.get('/v1/policies', async (request, reply) => {
    const catalog = await invokeBounded(request, handlerTimeoutMs, lifecycle.signal, (signal) =>
      dependencies.policies.get(signal)
    );
    return sendCanonical(reply, policyCatalogSchemaId, catalog);
  });
  server.post('/v1/preview/scan', {
    bodyLimit: localPreviewMaximumInputBytes,
    onRequest: (request, _reply, done) => { reservePreview(request); done(); },
    onError: (request, _reply, _error, done) => { releasePreview(request); done(); },
    onResponse: (request, _reply, done) => { releasePreview(request); done(); }
  }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) throw requestFailure(request);
    const report = await invokeBounded(request, handlerTimeoutMs, lifecycle.signal, (signal) =>
      dependencies.preview.scan(request.body as Buffer, previewFormat(request), {
        correlationId: requestCorrelationId(request)
      }, signal)
    );
    return sendCanonical(reply, previewScanSchemaId, {
      schemaVersion: '1.0.0',
      operation: report.operation,
      outcome: report.outcome,
      counts: report.counts
    });
  });
  server.post('/v1/preview/review', {
    bodyLimit: localPreviewMaximumInputBytes,
    onRequest: (request, _reply, done) => { reservePreview(request); done(); },
    onError: (request, _reply, _error, done) => { releasePreview(request); done(); },
    onResponse: (request, _reply, done) => { releasePreview(request); done(); }
  }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) throw requestFailure(request);
    const report = await invokeBounded(request, handlerTimeoutMs, lifecycle.signal, (signal) =>
      dependencies.preview.scan(request.body as Buffer, previewFormat(request), {
        correlationId: requestCorrelationId(request)
      }, signal)
    );
    return sendCanonical(reply, previewReviewSchemaId, report);
  });
  server.post('/v1/jobs', async (request, reply) => {
    const body = canonicalBody(request, createJobRequestSchemaId) as CreateJobRequest;
    const correlationId = requestCorrelationId(request);
    const result = await invokeBounded(request, handlerTimeoutMs, lifecycle.signal, (signal) =>
      dependencies.jobs.create(body, idempotencyKey(request), jobIdempotencyScope, correlationId, signal)
    );
    return sendCanonical(reply.status(result.replayed ? 200 : 201), jobSchemaId, result.job);
  });
  server.get('/v1/jobs/:jobId', async (request, reply) => {
    const correlationId = requestCorrelationId(request);
    const job = await invokeBounded(request, handlerTimeoutMs, lifecycle.signal, (signal) =>
      dependencies.jobs.get(jobIdParameter(request), correlationId, signal)
    );
    if (job === undefined) throw unavailableJob(request);
    return sendCanonical(reply, jobSchemaId, job);
  });
  server.get('/v1/jobs/:jobId/events', async (request, reply) => {
    const correlationId = requestCorrelationId(request);
    const jobId = jobIdParameter(request);
    const query = eventQuery(request);
    const page = await invokeBounded(request, handlerTimeoutMs, lifecycle.signal, (signal) =>
      dependencies.jobs.listEvents(jobId, query.afterCursor, query.limit, correlationId, signal)
    );
    if (page === undefined) throw unavailableJob(request);
    return sendCanonical(reply, jobEventPageSchemaId, page);
  });
  server.post('/v1/jobs/:jobId/cancellation', async (request, reply) => {
    const body = canonicalBody(request, cancelJobRequestSchemaId) as CancelJobRequest;
    const correlationId = requestCorrelationId(request);
    const result = await invokeBounded(request, handlerTimeoutMs, lifecycle.signal, (signal) =>
      dependencies.jobs.cancel(jobIdParameter(request), body, correlationId, signal)
    );
    if (result === undefined) throw unavailableJob(request);
    return sendCanonical(reply, jobSchemaId, result.job);
  });

  if (options.browserShell !== undefined) {
    registerLocalWebShell(server, options.session.bearerToken, options.browserShell);
  }

  return server;
}
