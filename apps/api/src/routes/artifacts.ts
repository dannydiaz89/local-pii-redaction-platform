import type { FastifyInstance } from 'fastify';

import { localPreviewMaximumInputBytes } from '@local-pii/contracts';

import type { CreateArtifactRequest } from '../processing.js';
import { apiContractIds } from '../contract-ids.js';
import {
  artifactIdParameter,
  canonicalBody,
  invokeBounded,
  requestCorrelationId,
  requestFailure,
  sendCanonical,
  unavailableJob
} from '../http-boundary.js';
import type { ApiRouteContext } from './context.js';

export function registerArtifactRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const { dependencies, handlerTimeoutMs, lifecycleSignal } = context;

  server.post('/v1/artifacts', async (request, reply) => {
    const processing = dependencies.processing;
    if (processing === undefined) throw unavailableJob(request);
    const schemaId = request.body !== null
      && typeof request.body === 'object'
      && !Array.isArray(request.body)
      && (request.body as Readonly<Record<string, unknown>>).schemaVersion === '2.0.0'
      ? apiContractIds.createArtifactRequestV2
      : apiContractIds.createArtifactRequest;
    const body = canonicalBody(request, schemaId) as CreateArtifactRequest;
    const artifact = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      processing.initiateArtifact(body, requestCorrelationId(request), signal)
    );
    return sendCanonical(reply.status(201), apiContractIds.artifact, artifact);
  });

  server.put('/v1/artifacts/:artifactId/content', {
    bodyLimit: localPreviewMaximumInputBytes
  }, async (request, reply) => {
    const processing = dependencies.processing;
    if (processing === undefined) throw unavailableJob(request);
    if (!Buffer.isBuffer(request.body)) throw requestFailure(request);
    const artifact = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      processing.uploadArtifact(
        artifactIdParameter(request),
        request.body as Buffer,
        requestCorrelationId(request),
        signal
      )
    );
    return sendCanonical(reply, apiContractIds.artifact, artifact);
  });

  server.get('/v1/artifacts/:artifactId/content', async (request, reply) => {
    const processing = dependencies.processing;
    if (processing === undefined) throw unavailableJob(request);
    const output = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      processing.downloadOutput(artifactIdParameter(request), requestCorrelationId(request), signal)
    );
    if (output === undefined) throw unavailableJob(request);
    reply.type(output.artifact.mediaType);
    reply.header('content-length', String(output.bytes.byteLength));
    reply.header('content-disposition', `attachment; filename="${output.artifact.displayName}"`);
    reply.header('x-local-pii-digest', output.artifact.digest);
    const payload = Buffer.from(output.bytes);
    output.bytes.fill(0);
    return reply.send(payload);
  });
}
