import { createHash, timingSafeEqual } from 'node:crypto';

import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from 'fastify';

import type { ApiDependencies, BuildApiOptions, LocalSessionPolicy } from './api-types.js';
import {
  HttpSafeError,
  requestCorrelationId,
  safeError,
  sendError,
  statusFor
} from './http-boundary.js';
import { registerLocalWebShell, isLocalWebShellRoute } from './web-shell.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import type { ApiRouteContext } from './routes/context.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerPreviewRoutes } from './routes/preview.js';
import { registerSystemRoutes } from './routes/system.js';

export type {
  ApiDependencies,
  ApiReadinessPort,
  BuildApiOptions,
  CapabilityApplicationPort,
  CapabilityManifest,
  LocalSessionPolicy,
  PolicyCatalog,
  PolicyCatalogPort
} from './api-types.js';

export const apiMaximumBodyBytes = 16 * 1024;
export const apiDefaultHandlerTimeoutMs = 5_000;

const tokenPattern = /^[A-Za-z0-9_-]{43,128}$/u;

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

function setCorsHeaders(reply: FastifyReply, origin: string): void {
  reply.header('access-control-allow-origin', origin);
  reply.header('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
  reply.header('access-control-allow-headers', 'authorization, content-type, idempotency-key');
  reply.header('access-control-max-age', '300');
  reply.header('vary', 'Origin');
}

function requestedHeadersAreAllowed(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return true;
  const allowed = new Set(['authorization', 'content-type', 'idempotency-key']);
  return value.split(',').every((header) => allowed.has(header.trim().toLowerCase()));
}

function handlerTimeout(options: BuildApiOptions): number {
  const timeout = options.handlerTimeoutMs ?? apiDefaultHandlerTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) {
    throw new TypeError('The API handler timeout is outside the supported range.');
  }
  return timeout;
}

export function buildApi(dependencies: ApiDependencies, options: BuildApiOptions): FastifyInstance {
  const allowedOrigins = validateSessionPolicy(options.session);
  const jobIdempotencyScope = `session-${createHash('sha256')
    .update(options.session.bearerToken, 'utf8')
    .digest('hex')}`;
  const lifecycle = new AbortController();
  const handlerTimeoutMs = handlerTimeout(options);

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

  server.addHook('preClose', async () => {
    lifecycle.abort();
    await dependencies.processing?.close();
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
        || (requestedMethod !== 'GET' && requestedMethod !== 'POST' && requestedMethod !== 'PUT')
        || !requestedHeadersAreAllowed(request.headers['access-control-request-headers'])
      ) {
        throw originFailure(request);
      }
      return;
    }

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

  const routeContext: ApiRouteContext = {
    dependencies,
    handlerTimeoutMs,
    jobIdempotencyScope,
    lifecycleSignal: lifecycle.signal
  };
  registerSystemRoutes(server, routeContext);
  registerArtifactRoutes(server, routeContext);
  registerPreviewRoutes(server, routeContext);
  registerJobRoutes(server, routeContext);

  if (options.browserShell !== undefined) {
    registerLocalWebShell(server, options.session.bearerToken, options.browserShell);
  }

  return server;
}
