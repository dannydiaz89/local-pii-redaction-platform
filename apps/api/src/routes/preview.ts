import type { FastifyInstance, FastifyRequest } from 'fastify';

import { localPreviewMaximumInputBytes } from '@local-pii/contracts';

import { apiContractIds } from '../contract-ids.js';
import {
  HttpSafeError,
  invokeBounded,
  previewFormat,
  requestCorrelationId,
  requestFailure,
  sendCanonical
} from '../http-boundary.js';
import type { ApiRouteContext } from './context.js';

export function registerPreviewRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const { dependencies, handlerTimeoutMs, lifecycleSignal } = context;
  const activeRequests = new WeakSet<FastifyRequest>();
  let active = false;
  const reserve = (request: FastifyRequest): void => {
    if (active) {
      throw new HttpSafeError(429, {
        code: 'RATE_LIMITED',
        message: 'Another local preview scan is already running.',
        retryable: true,
        correlationId: requestCorrelationId(request)
      });
    }
    active = true;
    activeRequests.add(request);
  };
  const release = (request: FastifyRequest): void => {
    if (activeRequests.delete(request)) active = false;
  };
  const lifecycle = {
    bodyLimit: localPreviewMaximumInputBytes,
    onRequest: (request: FastifyRequest, _reply: unknown, done: () => void) => { reserve(request); done(); },
    onError: (request: FastifyRequest, _reply: unknown, _error: unknown, done: () => void) => {
      release(request);
      done();
    },
    onResponse: (request: FastifyRequest, _reply: unknown, done: () => void) => { release(request); done(); }
  };

  server.post('/v1/preview/scan', lifecycle, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) throw requestFailure(request);
    const report = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      dependencies.preview.scan(request.body as Buffer, previewFormat(request), {
        correlationId: requestCorrelationId(request)
      }, signal)
    );
    return sendCanonical(reply, apiContractIds.previewScan, {
      schemaVersion: '1.0.0',
      operation: report.operation,
      outcome: report.outcome,
      counts: report.counts
    });
  });
  server.post('/v1/preview/review', lifecycle, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) throw requestFailure(request);
    const report = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      dependencies.preview.scan(request.body as Buffer, previewFormat(request), {
        correlationId: requestCorrelationId(request)
      }, signal)
    );
    return sendCanonical(reply, apiContractIds.previewReview, report);
  });
}
