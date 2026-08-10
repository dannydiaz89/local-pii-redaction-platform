import type { FastifyInstance } from 'fastify';

import { HttpSafeError, invokeBounded, requestCorrelationId, sendCanonical } from '../http-boundary.js';
import { apiContractIds } from '../contract-ids.js';
import type { ApiRouteContext } from './context.js';

export function registerSystemRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const { dependencies, handlerTimeoutMs, lifecycleSignal } = context;
  server.options('/v1/*', (_request, reply) => reply.status(204).send());
  server.get('/health/live', (_request, reply) => reply.status(204).send());
  server.get('/health/ready', async (request, reply) => {
    try {
      await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) => dependencies.readiness.check(signal));
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
    const manifest = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      dependencies.application.getCapabilities({ correlationId: requestCorrelationId(request) }, signal)
    );
    return sendCanonical(reply, apiContractIds.capability, manifest);
  });
  server.get('/v1/policies', async (request, reply) => {
    const catalog = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      dependencies.policies.get(signal)
    );
    return sendCanonical(reply, apiContractIds.policyCatalog, catalog);
  });
}
