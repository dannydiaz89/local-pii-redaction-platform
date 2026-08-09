import { timingSafeEqual } from 'node:crypto';

import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from 'fastify';

import {
  validateContract,
  type CapabilitiesCapabilityManifestContract,
  type CommonErrorsContract,
  type CommonErrorsV2Contract,
  type CommonErrorsV3Contract
} from '@local-pii/contracts';
import type { ApplicationContext } from '@local-pii/core';
import { SafeError } from '@local-pii/domain';

export type CapabilityManifest = CapabilitiesCapabilityManifestContract.CapabilityManifest;
type ErrorEnvelope = CommonErrorsContract.TypedErrorEnvelope
  | CommonErrorsV2Contract.TypedErrorEnvelopeV2
  | CommonErrorsV3Contract.TypedErrorEnvelopeV3;

export interface CapabilityApplicationPort {
  getCapabilities(context: ApplicationContext, signal?: AbortSignal): Promise<CapabilityManifest>;
}

export interface ApiReadinessPort {
  check(signal?: AbortSignal): Promise<void>;
}

export interface ApiDependencies {
  readonly application: CapabilityApplicationPort;
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
}

export const apiMaximumBodyBytes = 16 * 1024;
export const apiDefaultHandlerTimeoutMs = 5_000;

const capabilitySchemaId = 'https://local-pii.dev/schemas/capabilities/capability-manifest/1.0.0';
const errorSchemaId = 'https://local-pii.dev/schemas/common/errors/1.0.0';
const errorSchemaV2Id = 'https://local-pii.dev/schemas/common/errors/2.0.0';
const errorSchemaV3Id = 'https://local-pii.dev/schemas/common/errors/3.0.0';
const tokenPattern = /^[A-Za-z0-9_-]{43,128}$/u;

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
  if (error.code === 'FORMAT_UNSUPPORTED') return 415;
  if (error.code === 'POLICY_UNSATISFIABLE') return 422;
  if (error.code === 'AUTHORIZATION_DENIED') return 403;
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
  reply.header('access-control-allow-methods', 'GET, OPTIONS');
  reply.header('access-control-allow-headers', 'authorization, content-type');
  reply.header('access-control-max-age', '300');
  reply.header('vary', 'Origin');
}

function requestedHeadersAreAllowed(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return true;
  const allowed = new Set(['authorization', 'content-type']);
  return value.split(',').every((header) => allowed.has(header.trim().toLowerCase()));
}

export function buildApi(dependencies: ApiDependencies, options: BuildApiOptions): FastifyInstance {
  const allowedOrigins = validateSessionPolicy(options.session);
  const lifecycle = new AbortController();
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
      if (!allowedOrigins.has(origin)) throw originFailure(request);
      setCorsHeaders(reply, origin);
    }

    if (request.method === 'OPTIONS') {
      const requestedMethod = request.headers['access-control-request-method'];
      if (
        origin === undefined
        || requestedMethod !== 'GET'
        || !requestedHeadersAreAllowed(request.headers['access-control-request-headers'])
      ) {
        throw originFailure(request);
      }
      return;
    }

    // Health endpoints are intentionally secret-free probes. The numeric-loopback Host and
    // browser-origin boundary still applies, and readiness discloses only ready/not-ready.
    if (request.routeOptions.url === '/health/live' || request.routeOptions.url === '/health/ready') return;
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

  return server;
}
