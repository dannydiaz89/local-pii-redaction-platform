import type { FastifyInstance } from 'fastify';

import type { CancelJobRequest, CreateJobRequest } from '../job-control.js';
import type { AppendReviewDecisionsRequest } from '../processing.js';
import { apiContractIds } from '../contract-ids.js';
import {
  canonicalBody,
  detectionQuery,
  eventQuery,
  idempotencyKey,
  invokeBounded,
  jobIdParameter,
  requestCorrelationId,
  sendCanonical,
  unavailableJob
} from '../http-boundary.js';
import type { ApiRouteContext } from './context.js';

export function registerJobRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const { dependencies, handlerTimeoutMs, jobIdempotencyScope, lifecycleSignal } = context;

  server.post('/v1/jobs', async (request, reply) => {
    const schemaVersion = request.body !== null
      && typeof request.body === 'object'
      && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>).schemaVersion
      : undefined;
    const processingRequest = schemaVersion === '2.0.0' || schemaVersion === '3.0.0' || schemaVersion === '4.0.0';
    const jobs = processingRequest ? dependencies.processing : dependencies.jobs;
    if (jobs === undefined) throw unavailableJob(request);
    const body = canonicalBody(
      request,
      schemaVersion === '4.0.0'
        ? apiContractIds.createReviewedLocalRedactionJobRequest
        : schemaVersion === '3.0.0'
          ? apiContractIds.createLocalProcessingJobRequest
        : processingRequest
          ? apiContractIds.createProcessingJobRequest
          : apiContractIds.createJobRequest
    ) as CreateJobRequest;
    const correlationId = requestCorrelationId(request);
    const result = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      jobs.create(body, idempotencyKey(request), jobIdempotencyScope, correlationId, signal)
    );
    return sendCanonical(reply.status(result.replayed ? 200 : 201), apiContractIds.job, result.job);
  });

  server.get('/v1/jobs/:jobId', async (request, reply) => {
    const correlationId = requestCorrelationId(request);
    const job = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      dependencies.jobs.get(jobIdParameter(request), correlationId, signal)
    );
    if (job === undefined) throw unavailableJob(request);
    return sendCanonical(reply, apiContractIds.job, job);
  });

  server.delete('/v1/jobs/:jobId', async (request, reply) => {
    const job = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      dependencies.jobs.expire(jobIdParameter(request), requestCorrelationId(request), signal)
    );
    if (job === undefined) throw unavailableJob(request);
    return reply.status(204).send();
  });

  server.get('/v1/jobs/:jobId/events', async (request, reply) => {
    const correlationId = requestCorrelationId(request);
    const jobId = jobIdParameter(request);
    const query = eventQuery(request);
    const page = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      dependencies.jobs.listEvents(jobId, query.afterCursor, query.limit, correlationId, signal)
    );
    if (page === undefined) throw unavailableJob(request);
    return sendCanonical(reply, apiContractIds.jobEventPage, page);
  });

  server.get('/v1/jobs/:jobId/detections', async (request, reply) => {
    const processing = dependencies.processing;
    if (processing === undefined) throw unavailableJob(request);
    const correlationId = requestCorrelationId(request);
    const query = detectionQuery(request);
    const page = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      processing.listDetections(jobIdParameter(request), query.cursor, query.limit, correlationId, signal)
    );
    if (page === undefined) throw unavailableJob(request);
    return sendCanonical(reply, apiContractIds.detectionPage, page);
  });

  server.get('/v1/jobs/:jobId/review-decisions', async (request, reply) => {
    const processing = dependencies.processing;
    if (processing === undefined) throw unavailableJob(request);
    const reviewSet = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      processing.getReviewSet(jobIdParameter(request), requestCorrelationId(request), signal)
    );
    if (reviewSet === undefined) throw unavailableJob(request);
    return sendCanonical(reply, apiContractIds.reviewSet, reviewSet);
  });

  server.post('/v1/jobs/:jobId/review-decisions', async (request, reply) => {
    const processing = dependencies.processing;
    if (processing === undefined) throw unavailableJob(request);
    const body = canonicalBody(request, apiContractIds.reviewDecisionRequest) as AppendReviewDecisionsRequest;
    const reviewSet = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      processing.appendReviewDecisions(
        jobIdParameter(request), body, requestCorrelationId(request), signal
      )
    );
    if (reviewSet === undefined) throw unavailableJob(request);
    return sendCanonical(reply, apiContractIds.reviewSet, reviewSet);
  });

  server.get('/v1/jobs/:jobId/output', async (request, reply) => {
    const processing = dependencies.processing;
    if (processing === undefined) throw unavailableJob(request);
    const output = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      processing.outputForJob(jobIdParameter(request), requestCorrelationId(request), signal)
    );
    if (output === undefined) throw unavailableJob(request);
    return sendCanonical(reply, apiContractIds.artifact, output);
  });

  server.post('/v1/jobs/:jobId/cancellation', async (request, reply) => {
    const body = canonicalBody(request, apiContractIds.cancelJobRequest) as CancelJobRequest;
    const correlationId = requestCorrelationId(request);
    const result = await invokeBounded(request, handlerTimeoutMs, lifecycleSignal, (signal) =>
      dependencies.jobs.cancel(jobIdParameter(request), body, correlationId, signal)
    );
    if (result === undefined) throw unavailableJob(request);
    return sendCanonical(reply, apiContractIds.job, result.job);
  });
}
