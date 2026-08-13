import {
  assertContract,
  isRfc3339DateTime,
  type JobsJobContract,
  type JobsJobEventContract
} from '@local-pii/contracts';
import {
  canTransition,
  parseCorrelationId,
  parseEventId,
  parseJobId,
  parseSha256Digest,
  SafeError,
  unicodeCodePointLength,
  type ErrorCode,
  type JobState
} from '@local-pii/domain';

export type Job = Readonly<JobsJobContract.Job>;
export type JobEvent = Readonly<JobsJobEventContract.JobEvent>;
export type JobOperation = Job['operation'];

export interface JobPolicyReference {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface JobSummary {
  readonly detections?: number;
  readonly conflicts?: number;
  readonly findings?: number;
}

export interface JobIdempotency {
  readonly scope: string;
  readonly key: string;
  readonly requestDigest: string;
}

export interface CreateJobCommand {
  readonly jobId: string;
  readonly operation: JobOperation;
  readonly policy: JobPolicyReference;
  readonly now: string;
  readonly expiresAt?: string;
  readonly eventId: string;
  readonly idempotency: JobIdempotency;
  readonly correlationId: string;
}

export interface TransitionJobCommand {
  readonly jobId: string;
  readonly expectedRevision: number;
  readonly to: JobState;
  readonly now: string;
  readonly eventId: string;
  readonly summary?: JobSummary;
  readonly correlationId: string;
}

export interface JobMutationResult {
  readonly job: Job;
  readonly event: JobEvent;
  readonly replayed: boolean;
}

export interface ListJobEventsQuery {
  readonly jobId: string;
  readonly afterCursor?: number;
  readonly limit?: number;
  readonly correlationId: string;
}

export interface JobMetadataStore {
  create(command: CreateJobCommand, signal?: AbortSignal): Promise<JobMutationResult>;
  transition(command: TransitionJobCommand, signal?: AbortSignal): Promise<JobMutationResult>;
  get(jobId: string, correlationId: string, signal?: AbortSignal): Promise<Job | undefined>;
  listEvents(query: ListJobEventsQuery, signal?: AbortSignal): Promise<readonly JobEvent[]>;
}

export interface JobOutboxMessage {
  readonly schemaVersion: '1.0.0';
  readonly cursor: number;
  readonly eventId: string;
  readonly jobId: string;
  readonly revision: number;
  readonly eventCursor: number;
  readonly eventType: JobEvent['type'];
  readonly occurredAt: string;
  /** Value-free consumer deduplication identity. */
  readonly deduplicationKey: string;
}

export interface ListJobOutboxQuery {
  readonly afterCursor?: number;
  readonly limit?: number;
  readonly correlationId: string;
}

export interface AcknowledgeJobOutboxCommand {
  readonly eventId: string;
  readonly revision: number;
  readonly acknowledgedAt: string;
  readonly correlationId: string;
}

export interface JobOutboxAcknowledgement {
  readonly message: JobOutboxMessage;
  readonly acknowledgedAt: string;
  readonly replayed: boolean;
}

export interface ClaimJobOutboxCommand {
  readonly consumerId: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
  readonly limit?: number;
  readonly correlationId: string;
}

export interface JobOutboxClaim {
  readonly message: JobOutboxMessage;
  readonly consumerId: string;
  readonly attempt: number;
  readonly leasedAt: string;
  readonly leaseExpiresAt: string;
}

export interface CompleteJobOutboxClaimCommand {
  readonly eventId: string;
  readonly revision: number;
  readonly consumerId: string;
  readonly attempt: number;
  readonly acknowledgedAt: string;
  readonly correlationId: string;
}

export interface FailJobOutboxClaimCommand {
  readonly eventId: string;
  readonly revision: number;
  readonly consumerId: string;
  readonly attempt: number;
  readonly failedAt: string;
  readonly retryAt: string;
  readonly correlationId: string;
}

export interface JobOutboxFailureResult {
  readonly message: JobOutboxMessage;
  readonly attempt: number;
  readonly disposition: 'RETRY_SCHEDULED' | 'DEAD_LETTERED';
  readonly availableAt?: string;
  readonly deadLetteredAt?: string;
}

export interface ListDeadLetterOutboxQuery {
  readonly afterCursor?: number;
  readonly limit?: number;
  readonly correlationId: string;
}

export interface JobOutboxDeadLetter {
  readonly message: JobOutboxMessage;
  readonly attempts: number;
  readonly deadLetteredAt: string;
}

export interface JobOutboxStore {
  listPendingOutbox(query: ListJobOutboxQuery, signal?: AbortSignal): Promise<readonly JobOutboxMessage[]>;
  claimPendingOutbox(command: ClaimJobOutboxCommand, signal?: AbortSignal): Promise<readonly JobOutboxClaim[]>;
  acknowledgeOutbox(
    command: AcknowledgeJobOutboxCommand,
    signal?: AbortSignal
  ): Promise<JobOutboxAcknowledgement>;
  completeOutboxClaim(
    command: CompleteJobOutboxClaimCommand,
    signal?: AbortSignal
  ): Promise<JobOutboxAcknowledgement>;
  failOutboxClaim(
    command: FailJobOutboxClaimCommand,
    signal?: AbortSignal
  ): Promise<JobOutboxFailureResult>;
  listDeadLetterOutbox(
    query: ListDeadLetterOutboxQuery,
    signal?: AbortSignal
  ): Promise<readonly JobOutboxDeadLetter[]>;
}

/** Canonical, validated creation material used by storage adapters. */
export interface PreparedJobCreation {
  readonly job: Job;
  readonly event: JobEvent;
  readonly idempotency: Readonly<JobIdempotency>;
}

/** Canonical, validated transition material used by storage adapters. */
export interface PreparedJobTransition {
  readonly job: Job;
  readonly event: JobEvent;
}

export interface ValidatedJobEventQuery {
  readonly jobId: string;
  readonly afterCursor: number;
  readonly limit: number;
}

export interface ValidatedJobOutboxQuery {
  readonly afterCursor: number;
  readonly limit: number;
}

export interface ValidatedJobOutboxAcknowledgement {
  readonly eventId: string;
  readonly revision: number;
  readonly acknowledgedAt: string;
}

export interface ValidatedJobOutboxClaim {
  readonly consumerId: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
  readonly limit: number;
}

export interface ValidatedJobOutboxClaimCompletion {
  readonly eventId: string;
  readonly revision: number;
  readonly consumerId: string;
  readonly attempt: number;
  readonly acknowledgedAt: string;
}

export interface ValidatedJobOutboxClaimFailure {
  readonly eventId: string;
  readonly revision: number;
  readonly consumerId: string;
  readonly attempt: number;
  readonly failedAt: string;
  readonly retryAt: string;
}

interface IdempotencyRecord {
  readonly requestDigest: string;
  readonly job: Job;
  readonly event: JobEvent;
}

const jobSchemaId = 'https://local-pii.dev/schemas/jobs/job/1.0.0';
const jobEventSchemaId = 'https://local-pii.dev/schemas/jobs/job-event/1.0.0';
const tokenPattern = /^[A-Za-z0-9._:-]+$/u;
const operations = new Set<JobOperation>(['SCAN', 'REDACT', 'VERIFY', 'INSPECT']);
const maximumEventPageSize = 100;
const maximumOutboxPageSize = 100;
export const maximumJobOutboxAttempts = 5;
export const maximumJobOutboxLeaseMilliseconds = 5 * 60 * 1_000;
export const maximumJobOutboxRetryMilliseconds = 24 * 60 * 60 * 1_000;

function fail(code: ErrorCode, message: string, retryable: boolean, correlationId: string): never {
  throw new SafeError({ code, message, retryable, correlationId });
}

function validToken(value: unknown): value is string {
  return typeof value === 'string'
    && unicodeCodePointLength(value) >= 1
    && unicodeCodePointLength(value) <= 128
    && tokenPattern.test(value);
}

function validateDateTime(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !isRfc3339DateTime(value) || !Number.isFinite(Date.parse(value))) {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
  return value;
}

function validateRevision(value: unknown, correlationId: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
  return value as number;
}

function validateCount(value: unknown, correlationId: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
  return value as number;
}

function validateSummary(summary: unknown, correlationId: string): JobSummary | undefined {
  if (summary === undefined) return undefined;
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
  const candidate = summary as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.some((key) => key !== 'detections' && key !== 'conflicts' && key !== 'findings')) {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
  const detections = validateCount(candidate.detections, correlationId);
  const conflicts = validateCount(candidate.conflicts, correlationId);
  const findings = validateCount(candidate.findings, correlationId);
  const validated: JobSummary = {
    ...(detections === undefined ? {} : { detections }),
    ...(conflicts === undefined ? {} : { conflicts }),
    ...(findings === undefined ? {} : { findings })
  };
  return Object.freeze(validated);
}

function validatePolicy(policy: unknown, correlationId: string): Readonly<JobPolicyReference> {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)
    || !('id' in policy) || !validToken(policy.id)
    || !('version' in policy) || typeof policy.version !== 'string'
    || !('digest' in policy) || typeof policy.digest !== 'string') {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
  let digest: string;
  try {
    digest = parseSha256Digest(policy.digest);
  } catch {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
  return Object.freeze({ id: policy.id, version: policy.version, digest });
}

function validateIdempotency(value: unknown, correlationId: string): Readonly<JobIdempotency> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !('scope' in value) || !validToken(value.scope)
    || !('key' in value) || !validToken(value.key)
    || !('requestDigest' in value) || typeof value.requestDigest !== 'string') {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
  let requestDigest: string;
  try {
    requestDigest = parseSha256Digest(value.requestDigest);
  } catch {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
  return Object.freeze({ scope: value.scope, key: value.key, requestDigest });
}

function validateJobId(value: string, correlationId: string): string {
  try {
    return parseJobId(value);
  } catch {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
}

function validateEventId(value: string, correlationId: string): string {
  try {
    return parseEventId(value);
  } catch {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
}

function assertCanonical(value: Job | JobEvent, schemaId: string, correlationId: string): void {
  try {
    assertContract(schemaId, value);
  } catch {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
}

function eventTypeForState(state: JobState): JobEvent['type'] {
  if (state === 'NEEDS_REVIEW') return 'REVIEW_REQUIRED';
  if (state === 'FAILED') return 'JOB_FAILED';
  if (state === 'VERIFIED' || state === 'SUCCEEDED') return 'JOB_COMPLETED';
  if (state === 'CANCELLING') return 'CANCELLATION_REQUESTED';
  return 'STATE_CHANGED';
}

function cloneJob(job: Job): Job {
  const { summary, ...base } = job;
  return Object.freeze({
    ...base,
    policy: Object.freeze({ ...job.policy }),
    ...(summary === undefined ? {} : { summary: Object.freeze({ ...summary }) })
  });
}

function cloneEvent(event: JobEvent): JobEvent {
  const { counts, ...base } = event;
  return Object.freeze({
    ...base,
    ...(counts === undefined ? {} : { counts: Object.freeze({ ...counts }) })
  });
}

function countsForSummary(summary: JobSummary | undefined): JobEvent['counts'] {
  return summary === undefined ? undefined : Object.freeze({ ...summary });
}

function idempotencyMapKey(scope: string, key: string): string {
  return `${String(scope.length)}:${scope}${key}`;
}

/**
 * Validates a lookup without exposing storage details. Adapters use this before touching their
 * backing store so malformed identifiers fail consistently across implementations.
 */
export function validateJobLookup(jobIdInput: string, correlationId: string): string {
  parseCorrelationId(correlationId);
  return validateJobId(jobIdInput, correlationId);
}

/** Builds the immutable revision-one aggregate and its atomic creation event. */
export function prepareJobCreation(command: CreateJobCommand): PreparedJobCreation {
  parseCorrelationId(command.correlationId);
  const correlationId = command.correlationId;
  const jobId = validateJobId(command.jobId, correlationId);
  const eventId = validateEventId(command.eventId, correlationId);
  const now = validateDateTime(command.now, correlationId);
  const expiresAt = command.expiresAt === undefined
    ? undefined
    : validateDateTime(command.expiresAt, correlationId);
  if (!operations.has(command.operation)) {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
  const idempotency = validateIdempotency(command.idempotency, correlationId);
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(now)) {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
  const policy = validatePolicy(command.policy, correlationId);
  const job: Job = Object.freeze({
    schemaVersion: '1.0.0',
    id: jobId,
    operation: command.operation,
    state: 'QUEUED',
    revision: 1,
    policy,
    createdAt: now,
    updatedAt: now,
    ...(expiresAt === undefined ? {} : { expiresAt })
  });
  const event: JobEvent = Object.freeze({
    schemaVersion: '1.0.0',
    id: eventId,
    jobId,
    cursor: 1,
    revision: 1,
    type: 'JOB_CREATED',
    occurredAt: now
  });
  assertCanonical(job, jobSchemaId, correlationId);
  assertCanonical(event, jobEventSchemaId, correlationId);
  return Object.freeze({ job, event, idempotency });
}

/** Builds the next immutable aggregate/event pair after enforcing revision and state rules. */
export function prepareJobTransition(
  current: Job,
  command: TransitionJobCommand
): PreparedJobTransition {
  parseCorrelationId(command.correlationId);
  const correlationId = command.correlationId;
  const jobId = validateJobId(command.jobId, correlationId);
  const eventId = validateEventId(command.eventId, correlationId);
  const now = validateDateTime(command.now, correlationId);
  const expectedRevision = validateRevision(command.expectedRevision, correlationId);
  assertCanonical(current, jobSchemaId, correlationId);
  if (current.id !== jobId) fail('JOB_CONFLICT', 'The job does not exist.', false, correlationId);
  if (current.revision !== expectedRevision) {
    fail('JOB_CONFLICT', 'The job revision changed.', true, correlationId);
  }
  if (!canTransition(current.state, command.to)) {
    fail('JOB_CONFLICT', 'The job state transition is not allowed.', false, correlationId);
  }
  if (Date.parse(now) < Date.parse(current.updatedAt)) {
    fail('SCHEMA_INVALID', 'The job metadata is invalid.', false, correlationId);
  }
  const summary = validateSummary(command.summary, correlationId);
  const revision = current.revision + 1;
  const job: Job = Object.freeze({
    ...current,
    state: command.to,
    revision,
    updatedAt: now,
    ...(summary === undefined ? {} : { summary })
  });
  const counts = countsForSummary(summary);
  const event: JobEvent = Object.freeze({
    schemaVersion: '1.0.0',
    id: eventId,
    jobId,
    cursor: revision,
    revision,
    type: eventTypeForState(command.to),
    occurredAt: now,
    ...(counts === undefined ? {} : { counts })
  });
  assertCanonical(job, jobSchemaId, correlationId);
  assertCanonical(event, jobEventSchemaId, correlationId);
  return Object.freeze({ job, event });
}

export function validateJobEventQuery(query: ListJobEventsQuery): ValidatedJobEventQuery {
  parseCorrelationId(query.correlationId);
  const jobId = validateJobId(query.jobId, query.correlationId);
  const afterCursor = query.afterCursor ?? 0;
  const limit = query.limit ?? maximumEventPageSize;
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > maximumEventPageSize) {
    fail('SCHEMA_INVALID', 'The event query is invalid.', false, query.correlationId);
  }
  return Object.freeze({ jobId, afterCursor, limit });
}

/** Validates value-free pending-delivery pagination before an adapter touches storage. */
export function validateJobOutboxQuery(query: ListJobOutboxQuery): ValidatedJobOutboxQuery {
  parseCorrelationId(query.correlationId);
  const afterCursor = query.afterCursor ?? 0;
  const limit = query.limit ?? maximumOutboxPageSize;
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > maximumOutboxPageSize) {
    fail('SCHEMA_INVALID', 'The outbox query is invalid.', false, query.correlationId);
  }
  return Object.freeze({ afterCursor, limit });
}

/** Validates the consumer's idempotent event/revision acknowledgement identity. */
export function validateJobOutboxAcknowledgement(
  command: AcknowledgeJobOutboxCommand
): ValidatedJobOutboxAcknowledgement {
  parseCorrelationId(command.correlationId);
  const eventId = validateEventId(command.eventId, command.correlationId);
  const revision = validateRevision(command.revision, command.correlationId);
  const acknowledgedAt = validateDateTime(command.acknowledgedAt, command.correlationId);
  return Object.freeze({ eventId, revision, acknowledgedAt });
}

function validateOutboxConsumerId(value: unknown, correlationId: string): string {
  if (typeof value !== 'string') {
    fail('SCHEMA_INVALID', 'The outbox delivery command is invalid.', false, correlationId);
  }
  try {
    return parseEventId(value);
  } catch {
    fail('SCHEMA_INVALID', 'The outbox delivery command is invalid.', false, correlationId);
  }
}

function validateOutboxAttempt(value: unknown, correlationId: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1
    || (value as number) > maximumJobOutboxAttempts) {
    fail('SCHEMA_INVALID', 'The outbox delivery command is invalid.', false, correlationId);
  }
  return value as number;
}

export function validateJobOutboxClaim(command: ClaimJobOutboxCommand): ValidatedJobOutboxClaim {
  parseCorrelationId(command.correlationId);
  const consumerId = validateOutboxConsumerId(command.consumerId, command.correlationId);
  const now = validateDateTime(command.now, command.correlationId);
  const leaseExpiresAt = validateDateTime(command.leaseExpiresAt, command.correlationId);
  const duration = Date.parse(leaseExpiresAt) - Date.parse(now);
  const limit = command.limit ?? maximumOutboxPageSize;
  if (duration < 1_000 || duration > maximumJobOutboxLeaseMilliseconds
    || !Number.isSafeInteger(limit) || limit < 1 || limit > maximumOutboxPageSize) {
    fail('SCHEMA_INVALID', 'The outbox delivery command is invalid.', false, command.correlationId);
  }
  return Object.freeze({ consumerId, now, leaseExpiresAt, limit });
}

export function validateJobOutboxClaimCompletion(
  command: CompleteJobOutboxClaimCommand
): ValidatedJobOutboxClaimCompletion {
  parseCorrelationId(command.correlationId);
  return Object.freeze({
    eventId: validateEventId(command.eventId, command.correlationId),
    revision: validateRevision(command.revision, command.correlationId),
    consumerId: validateOutboxConsumerId(command.consumerId, command.correlationId),
    attempt: validateOutboxAttempt(command.attempt, command.correlationId),
    acknowledgedAt: validateDateTime(command.acknowledgedAt, command.correlationId)
  });
}

export function validateJobOutboxClaimFailure(
  command: FailJobOutboxClaimCommand
): ValidatedJobOutboxClaimFailure {
  parseCorrelationId(command.correlationId);
  const failedAt = validateDateTime(command.failedAt, command.correlationId);
  const retryAt = validateDateTime(command.retryAt, command.correlationId);
  const delay = Date.parse(retryAt) - Date.parse(failedAt);
  if (delay < 1_000 || delay > maximumJobOutboxRetryMilliseconds) {
    fail('SCHEMA_INVALID', 'The outbox delivery command is invalid.', false, command.correlationId);
  }
  return Object.freeze({
    eventId: validateEventId(command.eventId, command.correlationId),
    revision: validateRevision(command.revision, command.correlationId),
    consumerId: validateOutboxConsumerId(command.consumerId, command.correlationId),
    attempt: validateOutboxAttempt(command.attempt, command.correlationId),
    failedAt,
    retryAt
  });
}

/**
 * Process-local reference implementation for contract development and tests.
 * It is intentionally volatile and is not a durable application profile.
 */
export function createVolatileJobMetadataStore(): JobMetadataStore {
  const jobs = new Map<string, Job>();
  const events = new Map<string, readonly JobEvent[]>();
  const idempotency = new Map<string, IdempotencyRecord>();
  const eventIds = new Set<string>();

  return Object.freeze({
    async create(command: CreateJobCommand, signal?: AbortSignal): Promise<JobMutationResult> {
      signal?.throwIfAborted();
      await Promise.resolve();
      signal?.throwIfAborted();
      const prepared = prepareJobCreation(command);
      const { job, event, idempotency: validatedIdempotency } = prepared;
      const { id: jobId } = job;
      const eventId = event.id;
      const correlationId = command.correlationId;

      const idempotencyKey = idempotencyMapKey(validatedIdempotency.scope, validatedIdempotency.key);
      const prior = idempotency.get(idempotencyKey);
      if (prior !== undefined) {
        if (prior.requestDigest !== validatedIdempotency.requestDigest) {
          fail('IDEMPOTENCY_CONFLICT', 'The request key was already used for different job metadata.', false, correlationId);
        }
        return Object.freeze({
          job: cloneJob(prior.job),
          event: cloneEvent(prior.event),
          replayed: true
        });
      }
      if (jobs.has(jobId)) {
        fail('JOB_CONFLICT', 'The job already exists.', false, correlationId);
      }
      if (eventIds.has(eventId)) {
        fail('JOB_CONFLICT', 'The job event already exists.', false, correlationId);
      }

      jobs.set(jobId, job);
      events.set(jobId, Object.freeze([event]));
      eventIds.add(eventId);
      idempotency.set(idempotencyKey, Object.freeze({
        requestDigest: validatedIdempotency.requestDigest,
        job,
        event
      }));
      return Object.freeze({ job: cloneJob(job), event: cloneEvent(event), replayed: false });
    },

    async transition(command: TransitionJobCommand, signal?: AbortSignal): Promise<JobMutationResult> {
      signal?.throwIfAborted();
      await Promise.resolve();
      signal?.throwIfAborted();
      const correlationId = command.correlationId;
      const jobId = validateJobLookup(command.jobId, correlationId);
      const current = jobs.get(jobId);
      if (current === undefined) fail('JOB_CONFLICT', 'The job does not exist.', false, correlationId);
      const prepared = prepareJobTransition(current, command);
      const { job, event } = prepared;
      const eventId = event.id;
      if (eventIds.has(eventId)) {
        fail('JOB_CONFLICT', 'The job event already exists.', false, correlationId);
      }

      jobs.set(jobId, job);
      events.set(jobId, Object.freeze([...(events.get(jobId) ?? []), event]));
      eventIds.add(eventId);
      return Object.freeze({ job: cloneJob(job), event: cloneEvent(event), replayed: false });
    },

    async get(jobIdInput: string, correlationId: string, signal?: AbortSignal): Promise<Job | undefined> {
      signal?.throwIfAborted();
      await Promise.resolve();
      signal?.throwIfAborted();
      const jobId = validateJobLookup(jobIdInput, correlationId);
      const job = jobs.get(jobId);
      return job === undefined ? undefined : cloneJob(job);
    },

    async listEvents(query: ListJobEventsQuery, signal?: AbortSignal): Promise<readonly JobEvent[]> {
      signal?.throwIfAborted();
      await Promise.resolve();
      signal?.throwIfAborted();
      const { jobId, afterCursor, limit } = validateJobEventQuery(query);
      return Object.freeze(
        (events.get(jobId) ?? [])
          .filter(({ cursor }) => cursor > afterCursor)
          .slice(0, limit)
          .map(cloneEvent)
      );
    }
  });
}
