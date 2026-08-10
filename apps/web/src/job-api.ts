import type {
  JobsJobContract,
  JobsJobEventPageContract
} from '@local-pii/contracts';

import {
  assertLocalApiSession,
  readBoundedJsonResponse,
  runBoundedLocalRequest,
  type LocalApiSession
} from './api.js';

export type JobOperation = JobsJobContract.Job['operation'];
export type JobState = JobsJobContract.Job['state'];
export type JobEventType = JobsJobEventPageContract.JobEvent['type'];

export interface PolicyReference {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  readonly example: boolean;
}

export interface PolicyCatalogSummary {
  readonly defaultPolicy: PolicyReference;
  readonly policies: readonly PolicyReference[];
}

export interface JobStatusSummary {
  readonly id: string;
  readonly operation: JobOperation;
  readonly state: JobState;
  readonly revision: number;
  readonly policy: Readonly<Pick<PolicyReference, 'id' | 'version' | 'digest'>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JobEventSummary {
  readonly id: string;
  readonly cursor: number;
  readonly revision: number;
  readonly type: JobEventType;
  readonly occurredAt: string;
  readonly counts?: Readonly<Record<string, number>>;
}

export interface JobEventPageSummary {
  readonly jobId: string;
  readonly nextCursor: number;
  readonly events: readonly JobEventSummary[];
}

export interface LocalJobClient {
  loadPolicies(signal: AbortSignal): Promise<PolicyCatalogSummary>;
  create(
    operation: JobOperation,
    policy: PolicyReference,
    idempotencyKey: string,
    signal: AbortSignal
  ): Promise<JobStatusSummary>;
  get(jobId: string, signal: AbortSignal): Promise<JobStatusSummary>;
  listEvents(jobId: string, afterCursor: number, limit: number, signal: AbortSignal): Promise<JobEventPageSummary>;
  cancel(jobId: string, expectedRevision: number, signal: AbortSignal): Promise<JobStatusSummary>;
}

const maximumPolicyResponseBytes = 64 * 1024;
const maximumJobResponseBytes = 64 * 1024;
const maximumEventResponseBytes = 128 * 1024;
export const jobRequestTimeoutMs = 5_000;
const policyIdPattern = /^[a-z][a-z0-9-]{2,63}$/u;
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const jobIdPattern = /^job_[0-9A-HJKMNP-TV-Z]{26}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const dateTimePattern = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])[Tt](?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/u;
const operations = new Set<JobOperation>(['SCAN', 'REDACT', 'VERIFY', 'INSPECT']);
const states = new Set<JobState>([
  'QUEUED', 'VALIDATING', 'EXTRACTING', 'DETECTING', 'RESOLVING', 'NEEDS_REVIEW',
  'REDACTING', 'VERIFYING', 'CANCELLING', 'VERIFIED', 'SUCCEEDED', 'FAILED',
  'CANCELLED', 'EXPIRED'
]);
const eventTypes = new Set<JobEventType>([
  'JOB_CREATED', 'STATE_CHANGED', 'REVIEW_REQUIRED', 'JOB_COMPLETED', 'JOB_FAILED', 'CANCELLATION_REQUESTED'
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function dateTime(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && dateTimePattern.test(value)
    && Number.isFinite(Date.parse(value));
}

function optionalCounts(value: unknown): boolean {
  return value === undefined || (isRecord(value)
    && hasOnlyKeys(value, ['detections', 'conflicts', 'findings'])
    && Object.values(value).every((count) => safeInteger(count)));
}

function projectPolicy(value: unknown): PolicyReference {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['id', 'version', 'digest', 'riskTier', 'example'])
    || typeof value.id !== 'string' || !policyIdPattern.test(value.id)
    || typeof value.version !== 'string' || !semverPattern.test(value.version)
    || typeof value.digest !== 'string' || !digestPattern.test(value.digest)
    || (value.riskTier !== 'LOW' && value.riskTier !== 'MODERATE' && value.riskTier !== 'HIGH')
    || typeof value.example !== 'boolean') {
    throw new Error('POLICY_RESPONSE_INVALID');
  }
  return Object.freeze({
    id: value.id,
    version: value.version,
    digest: value.digest,
    riskTier: value.riskTier,
    example: value.example
  });
}

export function projectPolicyCatalog(value: unknown): PolicyCatalogSummary {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'defaultPolicyId', 'policies'])
    || value.schemaVersion !== '1.0.0'
    || typeof value.defaultPolicyId !== 'string'
    || !policyIdPattern.test(value.defaultPolicyId)
    || !Array.isArray(value.policies)
    || value.policies.length < 1
    || value.policies.length > 32) {
    throw new Error('POLICY_RESPONSE_INVALID');
  }
  const policies = Object.freeze(value.policies.map(projectPolicy));
  if (new Set(policies.map(({ id }) => id)).size !== policies.length) throw new Error('POLICY_RESPONSE_INVALID');
  const defaultPolicy = policies.find(({ id }) => id === value.defaultPolicyId);
  if (defaultPolicy === undefined) throw new Error('POLICY_RESPONSE_INVALID');
  return Object.freeze({ defaultPolicy, policies });
}

function projectJob(value: unknown): JobStatusSummary {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'schemaVersion', 'id', 'operation', 'state', 'revision', 'policy', 'createdAt', 'updatedAt', 'expiresAt', 'summary'
    ])
    || value.schemaVersion !== '1.0.0'
    || typeof value.id !== 'string' || !jobIdPattern.test(value.id)
    || typeof value.operation !== 'string' || !operations.has(value.operation as JobOperation)
    || typeof value.state !== 'string' || !states.has(value.state as JobState)
    || !safeInteger(value.revision, 1)
    || !dateTime(value.createdAt) || !dateTime(value.updatedAt)
    || (value.expiresAt !== undefined && !dateTime(value.expiresAt))
    || !optionalCounts(value.summary)
    || !isRecord(value.policy)
    || !hasOnlyKeys(value.policy, ['id', 'version', 'digest'])
    || typeof value.policy.id !== 'string' || !policyIdPattern.test(value.policy.id)
    || typeof value.policy.version !== 'string' || !semverPattern.test(value.policy.version)
    || typeof value.policy.digest !== 'string' || !digestPattern.test(value.policy.digest)) {
    throw new Error('JOB_RESPONSE_INVALID');
  }
  return Object.freeze({
    id: value.id,
    operation: value.operation as JobOperation,
    state: value.state as JobState,
    revision: value.revision,
    policy: Object.freeze({ id: value.policy.id, version: value.policy.version, digest: value.policy.digest }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  });
}

function projectEvent(value: unknown, expectedJobId: string): JobEventSummary {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'id', 'jobId', 'cursor', 'revision', 'type', 'occurredAt', 'counts'])
    || value.schemaVersion !== '1.0.0'
    || typeof value.id !== 'string' || !uuidPattern.test(value.id)
    || value.jobId !== expectedJobId
    || !safeInteger(value.cursor, 1)
    || !safeInteger(value.revision, 1)
    || typeof value.type !== 'string' || !eventTypes.has(value.type as JobEventType)
    || !dateTime(value.occurredAt)) {
    throw new Error('JOB_EVENT_RESPONSE_INVALID');
  }
  let counts: Readonly<Record<string, number>> | undefined;
  if (value.counts !== undefined) {
    if (!isRecord(value.counts)
      || !hasOnlyKeys(value.counts, ['detections', 'conflicts', 'findings'])
      || Object.values(value.counts).some((count) => !safeInteger(count))) {
      throw new Error('JOB_EVENT_RESPONSE_INVALID');
    }
    counts = Object.freeze({ ...(value.counts as Readonly<Record<string, number>>) });
  }
  return Object.freeze({
    id: value.id,
    cursor: value.cursor,
    revision: value.revision,
    type: value.type as JobEventType,
    occurredAt: value.occurredAt,
    ...(counts === undefined ? {} : { counts })
  });
}

function projectEventPage(value: unknown, expectedJobId: string, afterCursor: number): JobEventPageSummary {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'jobId', 'nextCursor', 'events'])
    || value.schemaVersion !== '1.0.0'
    || value.jobId !== expectedJobId
    || !safeInteger(value.nextCursor, afterCursor)
    || !Array.isArray(value.events)
    || value.events.length > 100) {
    throw new Error('JOB_EVENT_RESPONSE_INVALID');
  }
  const events = Object.freeze(value.events.map((event) => projectEvent(event, expectedJobId)));
  let prior = afterCursor;
  for (const event of events) {
    if (event.cursor <= prior) throw new Error('JOB_EVENT_RESPONSE_INVALID');
    prior = event.cursor;
  }
  if ((events.at(-1)?.cursor ?? afterCursor) !== value.nextCursor) throw new Error('JOB_EVENT_RESPONSE_INVALID');
  return Object.freeze({ jobId: expectedJobId, nextCursor: value.nextCursor, events });
}

async function requestJson(
  origin: URL,
  bearerToken: string,
  fetchImplementation: typeof fetch,
  url: URL,
  init: Readonly<{ readonly method: 'GET' | 'POST'; readonly body?: string; readonly idempotencyKey?: string }>,
  signal: AbortSignal,
  maximumResponseBytes: number,
  invalidResponseCode: string
): Promise<unknown> {
  const response = await fetchImplementation(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${bearerToken}`,
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.idempotencyKey === undefined ? {} : { 'idempotency-key': init.idempotencyKey })
    },
    ...(init.body === undefined ? {} : { body: init.body }),
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal
  });
  if (url.origin !== origin.origin || !response.ok) throw new Error('JOB_REQUEST_FAILED');
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (mediaType !== 'application/json') throw new Error(invalidResponseCode);
  return readBoundedJsonResponse(response, maximumResponseBytes, invalidResponseCode);
}

export function createLocalJobClient(
  session: LocalApiSession,
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = jobRequestTimeoutMs
): LocalJobClient {
  const origin = assertLocalApiSession(session);
  const invoke = <Result>(signal: AbortSignal, operation: (operationSignal: AbortSignal) => Promise<Result>) =>
    runBoundedLocalRequest(signal, timeoutMs, 'JOB_REQUEST_CANCELLED', operation);
  const jobUrl = (jobId: string, suffix = ''): URL => {
    if (!jobIdPattern.test(jobId)) throw new TypeError('The job identifier is invalid.');
    return new URL(`/v1/jobs/${jobId}${suffix}`, origin);
  };

  const client: LocalJobClient = {
    loadPolicies(signal) {
      return invoke(signal, async (operationSignal) => projectPolicyCatalog(await requestJson(
        origin, session.bearerToken, fetchImplementation, new URL('/v1/policies', origin),
        { method: 'GET' }, operationSignal, maximumPolicyResponseBytes, 'POLICY_RESPONSE_INVALID'
      )));
    },

    create(operation, policy, idempotencyKey, signal) {
      if (!operations.has(operation) || !uuidPattern.test(idempotencyKey)) {
        throw new TypeError('The job creation request is invalid.');
      }
      const trustedPolicy = projectPolicy(policy);
      const body = JSON.stringify({
        schemaVersion: '1.0.0',
        operation,
        policy: { id: trustedPolicy.id, version: trustedPolicy.version, digest: trustedPolicy.digest }
      });
      return invoke(signal, async (operationSignal) => projectJob(await requestJson(
        origin, session.bearerToken, fetchImplementation, new URL('/v1/jobs', origin),
        { method: 'POST', body, idempotencyKey }, operationSignal, maximumJobResponseBytes, 'JOB_RESPONSE_INVALID'
      )));
    },

    get(jobId, signal) {
      return invoke(signal, async (operationSignal) => projectJob(await requestJson(
        origin, session.bearerToken, fetchImplementation, jobUrl(jobId),
        { method: 'GET' }, operationSignal, maximumJobResponseBytes, 'JOB_RESPONSE_INVALID'
      )));
    },

    listEvents(jobId, afterCursor, limit, signal) {
      if (!safeInteger(afterCursor) || !safeInteger(limit, 1, 100)) {
        throw new TypeError('The job event query is invalid.');
      }
      const url = jobUrl(jobId, '/events');
      url.searchParams.set('after', String(afterCursor));
      url.searchParams.set('limit', String(limit));
      return invoke(signal, async (operationSignal) => projectEventPage(await requestJson(
        origin, session.bearerToken, fetchImplementation, url,
        { method: 'GET' }, operationSignal, maximumEventResponseBytes, 'JOB_EVENT_RESPONSE_INVALID'
      ), jobId, afterCursor));
    },

    cancel(jobId, expectedRevision, signal) {
      if (!safeInteger(expectedRevision, 1)) throw new TypeError('The job revision is invalid.');
      return invoke(signal, async (operationSignal) => projectJob(await requestJson(
        origin, session.bearerToken, fetchImplementation, jobUrl(jobId, '/cancellation'),
        { method: 'POST', body: JSON.stringify({ schemaVersion: '1.0.0', expectedRevision }) },
        operationSignal, maximumJobResponseBytes, 'JOB_RESPONSE_INVALID'
      )));
    }
  };
  return Object.freeze(client);
}

export function createDisconnectedJobClient(): LocalJobClient {
  const unavailable = (): Promise<never> => Promise.reject(new Error('LOCAL_SESSION_MISSING'));
  return {
    loadPolicies: unavailable,
    create: unavailable,
    get: unavailable,
    listEvents: unavailable,
    cancel: unavailable
  };
}
