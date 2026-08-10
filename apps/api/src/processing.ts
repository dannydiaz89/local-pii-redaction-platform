import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type {
  ArtifactsArtifactContract,
  ArtifactsCreateArtifactRequestContract,
  JobsDetectionPageContract
} from '@local-pii/contracts';
import type { TextProcessingApplication, TextScanResult } from '@local-pii/core';
import {
  canTransition,
  parseArtifactId,
  SafeError,
  type EntityType
} from '@local-pii/domain';
import {
  createVolatileJobMetadataStore,
  type JobMetadataStore,
  type JobMutationResult
} from '@local-pii/job-store';

import {
  createJobControl,
  type CancelJobRequest,
  type CreateJobRequest,
  type Job,
  type JobControlPort,
  type JobEventPage,
  type ProcessingJobRequest
} from './job-control.js';
import { scanLocalTextBytes, type PreviewFormat } from './preview-scan.js';

export type Artifact = Readonly<ArtifactsArtifactContract.Artifact>;
export type CreateArtifactRequest = Readonly<ArtifactsCreateArtifactRequestContract.CreateLocalArtifactRequest>;
type GeneratedDetectionPage = JobsDetectionPageContract.JobDetectionPage;
export type DetectionPage = Readonly<Omit<GeneratedDetectionPage, 'detections' | 'conflictDetails'>> & {
  readonly detections: readonly Readonly<GeneratedDetectionPage['detections'][number]>[];
  readonly conflictDetails: readonly Readonly<GeneratedDetectionPage['conflictDetails'][number]>[];
};
type Detection = DetectionPage['detections'][number];

export interface ProcessingControlPort extends JobControlPort {
  initiateArtifact(
    request: CreateArtifactRequest,
    correlationId: string,
    signal?: AbortSignal
  ): Promise<Artifact>;
  uploadArtifact(
    artifactId: string,
    bytes: Uint8Array,
    correlationId: string,
    signal?: AbortSignal
  ): Promise<Artifact>;
  listDetections(
    jobId: string,
    cursor: number,
    limit: number,
    correlationId: string,
    signal?: AbortSignal
  ): Promise<DetectionPage | undefined>;
  close(): Promise<void>;
}

export interface ProcessingPolicyReference {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface VolatileProcessingOptions {
  readonly now?: () => Date;
  readonly randomArtifactBytes?: () => Uint8Array;
  readonly randomJobBytes?: () => Uint8Array;
  readonly createEventId?: () => string;
  readonly maximumArtifacts?: number;
  readonly maximumRetainedBytes?: number;
}

interface ArtifactRecord {
  metadata: Artifact;
  readonly expectedDigest: string;
  readonly format: PreviewFormat;
  bytes: Uint8Array | undefined;
}

interface JobResult {
  readonly detections: readonly Detection[];
  readonly byEntity: Readonly<Partial<Record<EntityType, number>>>;
  readonly conflicts: number;
  readonly conflictDetails: readonly GeneratedDetectionPage['conflictDetails'][number][];
}

const crockfordBase32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const maximumUlidTimestamp = 281_474_976_710_655;
const defaultMaximumArtifacts = 8;
const defaultMaximumRetainedBytes = 32 * 1024 * 1024;

function fail(
  code: SafeError['code'],
  message: string,
  retryable: boolean,
  correlationId: string
): never {
  throw new SafeError({ code, message, retryable, correlationId });
}

function encodeTimestamp(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > maximumUlidTimestamp) {
    throw new TypeError('The artifact clock is outside the supported range.');
  }
  let remaining = timestamp;
  const encoded = new Array<string>(10);
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = crockfordBase32.charAt(remaining % 32);
    remaining = Math.floor(remaining / 32);
  }
  return encoded.join('');
}

function createArtifactId(now: Date, bytes: Uint8Array): string {
  if (Number.isNaN(now.getTime()) || bytes.length !== 16) {
    throw new TypeError('The artifact identifier inputs are invalid.');
  }
  const random = Array.from(bytes, (byte) => crockfordBase32.charAt(byte & 31)).join('');
  return parseArtifactId(`art_${encodeTimestamp(now.getTime())}${random}`);
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function formatFor(mediaType: CreateArtifactRequest['mediaType']): PreviewFormat {
  return mediaType === 'text/markdown' ? 'markdown' : 'text';
}

function genericDisplayName(mediaType: CreateArtifactRequest['mediaType']): string {
  return mediaType === 'text/markdown' ? 'document.md' : 'document.txt';
}

function cloneArtifact(artifact: Artifact): Artifact {
  return Object.freeze({ ...artifact });
}

function stableDetectionId(result: TextScanResult, spanId: string): string {
  const bytes = createHash('sha256')
    .update('local-pii:job-detection:v1\u0000', 'utf8')
    .update(result.resolution.extractionRevision, 'utf8')
    .update('\u0000', 'utf8')
    .update(spanId, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function resultForScan(result: TextScanResult, correlationId: string): JobResult {
  const evidenceById = new Map<string, (typeof result.evidence)[number]>(
    result.evidence.map((evidence) => [evidence.id, evidence])
  );
  const byEntity: Partial<Record<EntityType, number>> = {};
  const detections = result.resolution.spans.map((span): Detection => {
    byEntity[span.entityType] = (byEntity[span.entityType] ?? 0) + 1;
    const sources = [...new Set(span.evidenceIds.map((id) => evidenceById.get(id)?.source)
      .filter((source) => source !== undefined))].sort();
    if (sources.length === 0) {
      fail('INTERNAL_ERROR', 'The scan result could not be reconciled.', false, correlationId);
    }
    return Object.freeze({
      id: stableDetectionId(result, span.id),
      entityType: span.entityType,
      start: span.start,
      end: span.end,
      offsetUnit: 'UNICODE_CODE_POINT',
      confidence: span.confidence,
      sources: Object.freeze(sources) as Detection['sources']
    });
  });
  const conflictDetails = result.resolution.conflicts.slice(0, 100).map((conflict) => {
    const evidence = conflict.evidenceIds.map((id) => evidenceById.get(id));
    if (evidence.some((item) => item === undefined)) {
      fail('INTERNAL_ERROR', 'The scan conflict evidence could not be reconciled.', false, correlationId);
    }
    const reconciled = evidence.filter((item) => item !== undefined);
    return Object.freeze({
      code: conflict.code,
      start: conflict.start,
      end: conflict.end,
      offsetUnit: 'UNICODE_CODE_POINT' as const,
      entityTypes: Object.freeze([...new Set(reconciled.map(({ entityType }) => entityType))].sort()),
      sources: Object.freeze([...new Set(reconciled.map(({ source }) => source))].sort())
    }) as GeneratedDetectionPage['conflictDetails'][number];
  });
  return Object.freeze({
    detections: Object.freeze(detections),
    byEntity: Object.freeze(byEntity),
    conflicts: result.resolution.conflicts.length,
    conflictDetails: Object.freeze(conflictDetails)
  });
}

function validatePositiveBound(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new TypeError('The volatile processing bound is invalid.');
  }
  return selected;
}

/**
 * Process-local artifact and scan-job implementation used only by the development browser profile.
 * Bytes are discarded after the worker completes; metadata/results disappear when the launcher exits.
 */
export function createVolatileProcessingControl(
  application: TextProcessingApplication,
  policies: readonly ProcessingPolicyReference[],
  options: VolatileProcessingOptions = {}
): ProcessingControlPort {
  const now = options.now ?? (() => new Date());
  const randomArtifactBytes = options.randomArtifactBytes ?? (() => randomBytes(16));
  const createEventId = options.createEventId ?? randomUUID;
  const maximumArtifacts = validatePositiveBound(options.maximumArtifacts, defaultMaximumArtifacts, 32);
  const maximumRetainedBytes = validatePositiveBound(
    options.maximumRetainedBytes,
    defaultMaximumRetainedBytes,
    256 * 1024 * 1024
  );
  const policyKeys = new Set(policies.map((policy) => `${policy.id}\u0000${policy.version}\u0000${policy.digest}`));
  if (policyKeys.size !== policies.length || policyKeys.size === 0) {
    throw new TypeError('The processing policy catalog is invalid.');
  }

  const store: JobMetadataStore = createVolatileJobMetadataStore();
  const jobs = createJobControl(store, {
    now,
    ...(options.randomJobBytes === undefined ? {} : { randomJobBytes: options.randomJobBytes }),
    createEventId
  });
  const artifacts = new Map<string, ArtifactRecord>();
  const artifactByJob = new Map<string, string>();
  const artifactClaimByRequest = new Map<string, string>();
  const requestClaimByArtifact = new Map<string, string>();
  const results = new Map<string, JobResult>();
  const controllers = new Map<string, AbortController>();
  const pending: string[] = [];
  let retainedBytes = 0;
  let activeWork: Promise<void> | undefined;
  let closed = false;

  const transition = async (
    job: Job,
    to: Parameters<JobMetadataStore['transition']>[0]['to'],
    correlationId: string,
    summary?: { readonly detections?: number; readonly conflicts?: number }
  ): Promise<Job> => {
    const changed = await store.transition({
      jobId: job.id,
      expectedRevision: job.revision,
      to,
      now: now().toISOString(),
      eventId: createEventId(),
      ...(summary === undefined ? {} : { summary }),
      correlationId
    });
    return changed.job;
  };

  const releaseArtifactBytes = (artifact: ArtifactRecord): void => {
    if (artifact.bytes === undefined) return;
    retainedBytes -= artifact.bytes.byteLength;
    artifact.bytes.fill(0);
    artifact.bytes = undefined;
  };

  const finishCancelledOrFailed = async (
    jobId: string,
    correlationId: string,
    cancelled: boolean
  ): Promise<void> => {
    const current = await store.get(jobId, correlationId);
    if (current === undefined) return;
    if (cancelled && current.state !== 'CANCELLING' && canTransition(current.state, 'CANCELLING')) {
      const cancelling = await transition(current, 'CANCELLING', correlationId);
      await transition(cancelling, 'CANCELLED', correlationId);
      return;
    }
    if (cancelled && current.state === 'CANCELLING') {
      await transition(current, 'CANCELLED', correlationId);
      return;
    }
    if (!cancelled && canTransition(current.state, 'FAILED')) {
      await transition(current, 'FAILED', correlationId);
    }
  };

  const runJob = async (jobId: string): Promise<void> => {
    const correlationId = `cor_worker_${jobId}`;
    const controller = controllers.get(jobId);
    const artifactId = artifactByJob.get(jobId);
    const artifact = artifactId === undefined ? undefined : artifacts.get(artifactId);
    if (controller === undefined || artifact === undefined || artifact.bytes === undefined) {
      await finishCancelledOrFailed(jobId, correlationId, controller?.signal.aborted === true);
      return;
    }
    try {
      controller.signal.throwIfAborted();
      let job = await store.get(jobId, correlationId);
      if (job === undefined) return;
      job = await transition(job, 'VALIDATING', correlationId);
      controller.signal.throwIfAborted();
      job = await transition(job, 'EXTRACTING', correlationId);
      job = await transition(job, 'DETECTING', correlationId);
      const scan = await scanLocalTextBytes(
        application,
        artifact.bytes,
        artifact.format,
        { correlationId },
        controller.signal
      );
      controller.signal.throwIfAborted();
      job = await transition(job, 'RESOLVING', correlationId);
      const result = resultForScan(scan, correlationId);
      results.set(jobId, result);
      await transition(
        job,
        scan.outcome,
        correlationId,
        { detections: result.detections.length, conflicts: result.conflicts }
      );
    } catch (error: unknown) {
      results.delete(jobId);
      await finishCancelledOrFailed(
        jobId,
        correlationId,
        controller.signal.aborted || (error instanceof SafeError && error.code === 'OPERATION_CANCELLED')
      );
    } finally {
      releaseArtifactBytes(artifact);
      controllers.delete(jobId);
    }
  };

  const pump = (): void => {
    if (activeWork !== undefined || closed) return;
    const next = pending.shift();
    if (next === undefined) return;
    activeWork = runJob(next).finally(() => {
      activeWork = undefined;
      pump();
    });
  };

  const control: ProcessingControlPort = {
    async initiateArtifact(request, correlationId, signal) {
      signal?.throwIfAborted();
      await Promise.resolve();
      signal?.throwIfAborted();
      if (closed) fail('STORAGE_UNAVAILABLE', 'The local processing session is unavailable.', true, correlationId);
      if (artifacts.size >= maximumArtifacts || retainedBytes + request.byteLength > maximumRetainedBytes) {
        fail('RATE_LIMITED', 'The local processing session has reached its artifact limit.', true, correlationId);
      }
      const createdAt = now();
      const id = createArtifactId(createdAt, randomArtifactBytes());
      const metadata: Artifact = Object.freeze({
        schemaVersion: '1.0.0',
        id,
        kind: 'INPUT',
        mediaType: request.mediaType,
        byteLength: request.byteLength,
        digest: request.digest,
        displayName: genericDisplayName(request.mediaType),
        publicationState: 'STAGED',
        createdAt: createdAt.toISOString()
      });
      artifacts.set(id, {
        metadata,
        expectedDigest: request.digest,
        format: formatFor(request.mediaType),
        bytes: undefined
      });
      return cloneArtifact(metadata);
    },

    async uploadArtifact(artifactIdInput, bytes, correlationId, signal) {
      signal?.throwIfAborted();
      await Promise.resolve();
      signal?.throwIfAborted();
      const artifactId = parseArtifactId(artifactIdInput);
      const artifact = artifacts.get(artifactId);
      if (artifact === undefined) {
        fail('AUTHORIZATION_DENIED', 'The requested artifact is unavailable.', false, correlationId);
      }
      if (artifact.metadata.publicationState !== 'STAGED' || artifact.bytes !== undefined) {
        fail('JOB_CONFLICT', 'The artifact content was already supplied.', false, correlationId);
      }
      if (bytes.byteLength !== artifact.metadata.byteLength || digestBytes(bytes) !== artifact.expectedDigest) {
        artifacts.delete(artifactId);
        fail('ARTIFACT_DIGEST_MISMATCH', 'The uploaded artifact did not match its declared digest.', false, correlationId);
      }
      if (retainedBytes + bytes.byteLength > maximumRetainedBytes) {
        artifacts.delete(artifactId);
        fail('RATE_LIMITED', 'The local processing session has reached its byte limit.', true, correlationId);
      }
      artifact.bytes = Uint8Array.from(bytes);
      retainedBytes += artifact.bytes.byteLength;
      artifact.metadata = Object.freeze({ ...artifact.metadata, publicationState: 'IMMUTABLE' });
      return cloneArtifact(artifact.metadata);
    },

    async create(request, idempotencyKey, idempotencyScope, correlationId, signal): Promise<JobMutationResult> {
      if (request.schemaVersion === '1.0.0') {
        return jobs.create(request, idempotencyKey, idempotencyScope, correlationId, signal);
      }
      const policyKey = `${request.policy.id}\u0000${request.policy.version}\u0000${request.policy.digest}`;
      if (!policyKeys.has(policyKey)) {
        fail('POLICY_UNSATISFIABLE', 'The requested processing policy is unavailable.', false, correlationId);
      }
      const artifactId = parseArtifactId(request.inputArtifactId);
      const artifact = artifacts.get(artifactId);
      if (artifact?.metadata.publicationState !== 'IMMUTABLE' || artifact.bytes === undefined) {
        fail('AUTHORIZATION_DENIED', 'The requested artifact is unavailable.', false, correlationId);
      }
      const requestClaim = `${idempotencyScope}\u0000${idempotencyKey}`;
      const priorArtifactForRequest = artifactClaimByRequest.get(requestClaim);
      if (priorArtifactForRequest !== undefined && priorArtifactForRequest !== artifactId) {
        fail('IDEMPOTENCY_CONFLICT', 'The request key was already used for a different artifact.', false, correlationId);
      }
      const priorRequestForArtifact = requestClaimByArtifact.get(artifactId);
      if (priorRequestForArtifact !== undefined && priorRequestForArtifact !== requestClaim) {
        fail('JOB_CONFLICT', 'The artifact is already bound to a scan job.', false, correlationId);
      }
      artifactClaimByRequest.set(requestClaim, artifactId);
      requestClaimByArtifact.set(artifactId, requestClaim);
      let result: JobMutationResult;
      try {
        result = await jobs.create(request, idempotencyKey, idempotencyScope, correlationId, signal);
      } catch (error: unknown) {
        if (artifactClaimByRequest.get(requestClaim) === artifactId) artifactClaimByRequest.delete(requestClaim);
        if (requestClaimByArtifact.get(artifactId) === requestClaim) requestClaimByArtifact.delete(artifactId);
        throw error;
      }
      const priorArtifact = artifactByJob.get(result.job.id);
      if (priorArtifact !== undefined && priorArtifact !== artifactId) {
        fail('IDEMPOTENCY_CONFLICT', 'The request key was already used for a different artifact.', false, correlationId);
      }
      if (!result.replayed) {
        artifactByJob.set(result.job.id, artifactId);
        controllers.set(result.job.id, new AbortController());
        pending.push(result.job.id);
        queueMicrotask(pump);
      }
      return result;
    },

    get(jobId, correlationId, signal) {
      return jobs.get(jobId, correlationId, signal);
    },

    listEvents(jobId, afterCursor, limit, correlationId, signal): Promise<JobEventPage | undefined> {
      return jobs.listEvents(jobId, afterCursor, limit, correlationId, signal);
    },

    async cancel(jobId, request: CancelJobRequest, correlationId, signal) {
      const result = await jobs.cancel(jobId, request, correlationId, signal);
      if (result !== undefined) controllers.get(jobId)?.abort();
      return result;
    },

    async listDetections(jobId, cursor, limit, correlationId, signal) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 10_000
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        fail('SCHEMA_INVALID', 'The detection page query is invalid.', false, correlationId);
      }
      const job = await jobs.get(jobId, correlationId, signal);
      if (job === undefined) return undefined;
      const result = results.get(jobId);
      if (result === undefined || (job.state !== 'SUCCEEDED' && job.state !== 'NEEDS_REVIEW')) {
        fail('JOB_CONFLICT', 'The scan results are not available yet.', true, correlationId);
      }
      const detections = result.detections.slice(cursor, cursor + limit);
      const following = cursor + detections.length;
      return Object.freeze({
        schemaVersion: '1.0.0',
        jobId,
        jobRevision: job.revision,
        total: result.detections.length,
        conflicts: result.conflicts,
        byEntity: Object.freeze({ ...result.byEntity }),
        cursor,
        nextCursor: following < result.detections.length ? following : null,
        detections: Object.freeze(detections),
        conflictDetails: result.conflictDetails,
        conflictDetailsLimited: result.conflicts > result.conflictDetails.length
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers.values()) controller.abort();
      if (activeWork !== undefined) await activeWork;
      for (const artifact of artifacts.values()) releaseArtifactBytes(artifact);
      artifacts.clear();
      artifactByJob.clear();
      artifactClaimByRequest.clear();
      requestClaimByArtifact.clear();
      results.clear();
      pending.splice(0);
    }
  };
  return Object.freeze(control);
}

export function isProcessingJobRequest(request: CreateJobRequest): request is ProcessingJobRequest {
  return request.schemaVersion === '2.0.0';
}
