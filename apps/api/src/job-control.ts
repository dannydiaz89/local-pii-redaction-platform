import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type {
  JobsCancelJobRequestContract,
  JobsCreateJobRequestContract,
  JobsCreateJobRequestV2Contract,
  JobsCreateJobRequestV3Contract,
  JobsCreateJobRequestV4Contract,
  JobsJobContract,
  JobsJobEventPageContract
} from '@local-pii/contracts';
import {
  createVolatileJobMetadataStore,
  type JobMetadataStore,
  type JobMutationResult
} from '@local-pii/job-store';

export type MetadataJobRequest = Readonly<JobsCreateJobRequestContract.CreateJobRequest>;
export type ProcessingJobRequest = Readonly<JobsCreateJobRequestV2Contract.CreateProcessingJobRequest>;
export type LocalProcessingJobRequest = Readonly<JobsCreateJobRequestV3Contract.CreateLocalProcessingJobRequest>;
export type ReviewedLocalRedactionJobRequest = Readonly<JobsCreateJobRequestV4Contract.CreateReviewedLocalRedactionJobRequest>;
export type CreateJobRequest = MetadataJobRequest | ProcessingJobRequest | LocalProcessingJobRequest | ReviewedLocalRedactionJobRequest;
export type CancelJobRequest = Readonly<JobsCancelJobRequestContract.CancelJobRequest>;
export type Job = Readonly<JobsJobContract.Job>;
export type JobEventPage = Readonly<Omit<JobsJobEventPageContract.JobEventPage, 'events'>> & {
  readonly events: readonly Readonly<JobsJobEventPageContract.JobEvent>[];
};

export interface JobControlPort {
  create(
    request: CreateJobRequest,
    idempotencyKey: string,
    idempotencyScope: string,
    correlationId: string,
    signal?: AbortSignal
  ): Promise<JobMutationResult>;
  get(jobId: string, correlationId: string, signal?: AbortSignal): Promise<Job | undefined>;
  listEvents(
    jobId: string,
    afterCursor: number,
    limit: number,
    correlationId: string,
    signal?: AbortSignal
  ): Promise<JobEventPage | undefined>;
  cancel(
    jobId: string,
    request: CancelJobRequest,
    correlationId: string,
    signal?: AbortSignal
  ): Promise<JobMutationResult | undefined>;
}

export interface JobControlOptions {
  readonly now?: () => Date;
  readonly randomJobBytes?: () => Uint8Array;
  readonly createEventId?: () => string;
}

const crockfordBase32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const maximumUlidTimestamp = 281_474_976_710_655;

function encodeTimestamp(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > maximumUlidTimestamp) {
    throw new TypeError('The job clock is outside the supported range.');
  }
  let remaining = timestamp;
  const encoded = new Array<string>(10);
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = crockfordBase32.charAt(remaining % 32);
    remaining = Math.floor(remaining / 32);
  }
  return encoded.join('');
}

function createJobId(now: Date, bytes: Uint8Array): string {
  if (Number.isNaN(now.getTime()) || bytes.length !== 16) {
    throw new TypeError('The job identifier inputs are invalid.');
  }
  const random = Array.from(bytes, (byte) => crockfordBase32.charAt(byte & 31)).join('');
  return `job_${encodeTimestamp(now.getTime())}${random}`;
}

function requestDigest(request: CreateJobRequest): string {
  const canonical = JSON.stringify([
    request.schemaVersion,
    request.operation,
    request.policy.id,
    request.policy.version,
    request.policy.digest,
    ...(request.schemaVersion === '1.0.0' ? [] : [request.inputArtifactId]),
    ...(request.schemaVersion === '4.0.0' ? [
      request.review.sourceJobId,
      request.review.expectedJobRevision,
      request.review.expectedExtractionRevision,
      request.review.expectedReviewRevision,
      request.review.expectedReviewDigest
    ] : [])
  ]);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function createJobControl(
  store: JobMetadataStore,
  options: JobControlOptions = {}
): JobControlPort {
  const now = options.now ?? (() => new Date());
  const randomJobBytes = options.randomJobBytes ?? (() => randomBytes(16));
  const createEventId = options.createEventId ?? randomUUID;

  return Object.freeze({
    async create(
      request: CreateJobRequest,
      idempotencyKey: string,
      idempotencyScope: string,
      correlationId: string,
      signal?: AbortSignal
    ) {
      const createdAt = now();
      return store.create({
        jobId: createJobId(createdAt, randomJobBytes()),
        operation: request.operation,
        policy: request.policy,
        now: createdAt.toISOString(),
        eventId: createEventId(),
        idempotency: {
          scope: idempotencyScope,
          key: idempotencyKey,
          requestDigest: requestDigest(request)
        },
        correlationId
      }, signal);
    },

    get(jobId: string, correlationId: string, signal?: AbortSignal) {
      return store.get(jobId, correlationId, signal);
    },

    async listEvents(
      jobId: string,
      afterCursor: number,
      limit: number,
      correlationId: string,
      signal?: AbortSignal
    ) {
      const job = await store.get(jobId, correlationId, signal);
      if (job === undefined) return undefined;
      const events = await store.listEvents({ jobId, afterCursor, limit, correlationId }, signal);
      const last = events.at(-1);
      return Object.freeze({
        schemaVersion: '1.0.0',
        jobId,
        nextCursor: last?.cursor ?? afterCursor,
        events
      });
    },

    async cancel(
      jobId: string,
      request: CancelJobRequest,
      correlationId: string,
      signal?: AbortSignal
    ) {
      const job = await store.get(jobId, correlationId, signal);
      if (job === undefined) return undefined;
      const cancelledAt = now();
      return store.transition({
        jobId,
        expectedRevision: request.expectedRevision,
        to: 'CANCELLING',
        now: cancelledAt.toISOString(),
        eventId: createEventId(),
        correlationId
      }, signal);
    }
  });
}

/** Process-local job control for the development web profile; it is not durable. */
export function createVolatileJobControl(options: JobControlOptions = {}): JobControlPort {
  return createJobControl(createVolatileJobMetadataStore(), options);
}
