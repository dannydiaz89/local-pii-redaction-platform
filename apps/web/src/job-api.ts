import type {
  CommonEntityTypeContract,
  JobsJobContract,
  JobsJobEventPageContract,
  JobsPreviewReviewReportV2Contract,
  JobsPreviewScanReportContract
} from '@local-pii/contracts';

import {
  assertLocalApiSession,
  readBoundedJsonResponse,
  readBoundedResponseBytes,
  runBoundedLocalRequest,
  type LocalApiSession
} from './api.js';
import {
  webPreviewMaximumConflictDetails,
  webPreviewMaximumDetectionDetails,
  webPreviewMaximumInputBytes,
  webRedactionMaximumOutputBytes
} from './preview-limit.js';

export type JobOperation = JobsJobContract.Job['operation'];
export type JobState = JobsJobContract.Job['state'];
export type JobEventType = JobsJobEventPageContract.JobEvent['type'];
export type PreviewEntityType = CommonEntityTypeContract.EntityType;
export type PreviewOutcome = JobsPreviewScanReportContract.EphemeralPreviewScanReport['outcome'];
export type PreviewDetectionSource = JobsPreviewReviewReportV2Contract.EphemeralPreviewReviewReportV2['detections'][number]['sources'][number];

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

export interface PreviewScanSummary {
  readonly outcome: PreviewOutcome;
  readonly detections: number;
  readonly conflicts: number;
  readonly byEntity: Readonly<Partial<Record<PreviewEntityType, number>>>;
  readonly details: readonly PreviewDetectionSummary[];
  readonly detailsLimited: boolean;
  readonly conflictDetails: readonly PreviewConflictSummary[];
  readonly conflictDetailsLimited: boolean;
}

export interface PreviewDetectionSummary {
  readonly entityType: PreviewEntityType;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
  readonly sources: readonly PreviewDetectionSource[];
}

export interface PreviewConflictSummary {
  readonly code: 'INCOMPATIBLE_OVERLAP';
  readonly start: number;
  readonly end: number;
  readonly entityTypes: readonly PreviewEntityType[];
  readonly sources: readonly PreviewDetectionSource[];
}

export type ScanProgressState = 'UPLOADING' | JobState;

export interface DetectionPageSummary {
  readonly jobId: string;
  readonly jobRevision: number;
  readonly detections: number;
  readonly conflicts: number;
  readonly byEntity: Readonly<Partial<Record<PreviewEntityType, number>>>;
  readonly cursor: number;
  readonly nextCursor: number | null;
  readonly details: readonly PreviewDetectionSummary[];
  readonly conflictDetails: readonly PreviewConflictSummary[];
  readonly conflictDetailsLimited: boolean;
}

export interface ProcessingScanSummary extends DetectionPageSummary {
  readonly outcome: PreviewOutcome;
  readonly job: JobStatusSummary;
  readonly events: readonly JobEventSummary[];
}

export interface RedactedOutputSummary {
  readonly id: string;
  readonly mediaType: 'text/plain' | 'text/markdown';
  readonly byteLength: number;
  readonly digest: string;
  readonly displayName: 'document.redacted.txt' | 'document.redacted.md';
  readonly bytes: Uint8Array;
}

export interface ProcessingRedactionSummary {
  readonly job: JobStatusSummary;
  readonly output: RedactedOutputSummary;
}

export interface LocalJobClient {
  loadPolicies(signal: AbortSignal): Promise<PolicyCatalogSummary>;
  scan(
    file: File,
    policy: PolicyReference,
    onProgress: (state: ScanProgressState) => void,
    signal: AbortSignal
  ): Promise<ProcessingScanSummary>;
  redact(
    file: File,
    policy: PolicyReference,
    onProgress: (state: ScanProgressState) => void,
    signal: AbortSignal
  ): Promise<ProcessingRedactionSummary>;
  listDetections(
    jobId: string,
    cursor: number,
    limit: number,
    signal: AbortSignal
  ): Promise<DetectionPageSummary>;
  scanPreview(file: File, signal: AbortSignal): Promise<PreviewScanSummary>;
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
const maximumPreviewResponseBytes = 128 * 1024;
const maximumDetectionResponseBytes = 128 * 1024;
export const jobRequestTimeoutMs = 5_000;
export const scanWorkflowTimeoutMs = 30_000;
const policyIdPattern = /^[a-z][a-z0-9-]{2,63}$/u;
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const jobIdPattern = /^job_[0-9A-HJKMNP-TV-Z]{26}$/u;
const artifactIdPattern = /^art_[0-9A-HJKMNP-TV-Z]{26}$/u;
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
const entityTypes = new Set<PreviewEntityType>([
  'PERSON', 'EMAIL', 'PHONE', 'ADDRESS', 'LOCATION', 'ORGANIZATION', 'DATE_OF_BIRTH', 'SSN',
  'NATIONAL_ID', 'PASSPORT', 'DRIVER_LICENSE', 'CREDIT_CARD', 'BANK_ACCOUNT', 'ROUTING_NUMBER',
  'MEDICAL_RECORD', 'HEALTH_PLAN_ID', 'ACCOUNT_ID', 'USERNAME', 'IP_ADDRESS', 'MAC_ADDRESS',
  'API_KEY', 'ACCESS_TOKEN', 'PASSWORD', 'CUSTOM'
]);
const detectionSources = new Set<PreviewDetectionSource>([
  'REGEX', 'CHECKSUM', 'STRUCTURED', 'DICTIONARY', 'MODEL', 'MANUAL'
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

export function projectPreviewScan(value: unknown): PreviewScanSummary {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'schemaVersion', 'operation', 'outcome', 'counts', 'detections', 'detailsLimited',
      'conflicts', 'conflictDetailsLimited'
    ])
    || value.schemaVersion !== '2.0.0'
    || value.operation !== 'SCAN'
    || (value.outcome !== 'SUCCEEDED' && value.outcome !== 'NEEDS_REVIEW')
    || !isRecord(value.counts)
    || !hasOnlyKeys(value.counts, ['detections', 'conflicts', 'byEntity'])
    || !safeInteger(value.counts.detections, 0, 10_000)
    || !safeInteger(value.counts.conflicts, 0, 10_000)
    || !isRecord(value.counts.byEntity)
    || Object.keys(value.counts.byEntity).length > entityTypes.size
    || !Array.isArray(value.detections)
    || value.detections.length > webPreviewMaximumDetectionDetails
    || typeof value.detailsLimited !== 'boolean'
    || !Array.isArray(value.conflicts)
    || value.conflicts.length > webPreviewMaximumConflictDetails
    || typeof value.conflictDetailsLimited !== 'boolean') {
    throw new Error('PREVIEW_RESPONSE_INVALID');
  }
  const byEntity: Partial<Record<PreviewEntityType, number>> = {};
  let total = 0;
  for (const [entityType, count] of Object.entries(value.counts.byEntity)) {
    if (!entityTypes.has(entityType as PreviewEntityType) || !safeInteger(count, 1, 10_000)) {
      throw new Error('PREVIEW_RESPONSE_INVALID');
    }
    byEntity[entityType as PreviewEntityType] = count;
    total += count;
  }
  if (total !== value.counts.detections
    || (value.outcome === 'SUCCEEDED') !== (value.counts.conflicts === 0)) {
    throw new Error('PREVIEW_RESPONSE_INVALID');
  }
  const details = value.detections.map((item): PreviewDetectionSummary => {
    if (!isRecord(item)
      || !hasOnlyKeys(item, ['entityType', 'start', 'end', 'offsetUnit', 'confidence', 'sources'])
      || typeof item.entityType !== 'string' || !entityTypes.has(item.entityType as PreviewEntityType)
      || !safeInteger(item.start, 0, 10_000_000)
      || !safeInteger(item.end, 1, 10_000_000)
      || item.start >= item.end
      || item.offsetUnit !== 'UNICODE_CODE_POINT'
      || typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1
      || !Array.isArray(item.sources) || item.sources.length < 1 || item.sources.length > detectionSources.size
      || item.sources.some((source) => typeof source !== 'string'
        || !detectionSources.has(source as PreviewDetectionSource))
      || new Set(item.sources).size !== item.sources.length
      || byEntity[item.entityType as PreviewEntityType] === undefined) {
      throw new Error('PREVIEW_RESPONSE_INVALID');
    }
    return Object.freeze({
      entityType: item.entityType as PreviewEntityType,
      start: item.start,
      end: item.end,
      confidence: item.confidence,
      sources: Object.freeze(item.sources as PreviewDetectionSource[])
    });
  });
  if (details.length !== Math.min(value.counts.detections, webPreviewMaximumDetectionDetails)
    || value.detailsLimited !== (value.counts.detections > webPreviewMaximumDetectionDetails)) {
    throw new Error('PREVIEW_RESPONSE_INVALID');
  }
  for (let index = 1; index < details.length; index += 1) {
    const prior = details[index - 1];
    const current = details[index];
    if (prior === undefined || current === undefined
      || prior.start > current.start
      || (prior.start === current.start && prior.end < current.end)) {
      throw new Error('PREVIEW_RESPONSE_INVALID');
    }
  }
  const conflictDetails = value.conflicts.map((item): PreviewConflictSummary => {
    if (!isRecord(item)
      || !hasOnlyKeys(item, ['code', 'start', 'end', 'offsetUnit', 'entityTypes', 'sources'])
      || item.code !== 'INCOMPATIBLE_OVERLAP'
      || !safeInteger(item.start, 0, 10_000_000)
      || !safeInteger(item.end, 1, 10_000_000)
      || item.start >= item.end
      || item.offsetUnit !== 'UNICODE_CODE_POINT'
      || !Array.isArray(item.entityTypes) || item.entityTypes.length < 1 || item.entityTypes.length > entityTypes.size
      || item.entityTypes.some((entityType) => typeof entityType !== 'string'
        || !entityTypes.has(entityType as PreviewEntityType))
      || new Set(item.entityTypes).size !== item.entityTypes.length
      || !Array.isArray(item.sources) || item.sources.length < 1 || item.sources.length > detectionSources.size
      || item.sources.some((source) => typeof source !== 'string'
        || !detectionSources.has(source as PreviewDetectionSource))
      || new Set(item.sources).size !== item.sources.length) {
      throw new Error('PREVIEW_RESPONSE_INVALID');
    }
    return Object.freeze({
      code: item.code,
      start: item.start,
      end: item.end,
      entityTypes: Object.freeze(item.entityTypes as PreviewEntityType[]),
      sources: Object.freeze(item.sources as PreviewDetectionSource[])
    });
  });
  if (conflictDetails.length !== Math.min(value.counts.conflicts, webPreviewMaximumConflictDetails)
    || value.conflictDetailsLimited !== (value.counts.conflicts > webPreviewMaximumConflictDetails)) {
    throw new Error('PREVIEW_RESPONSE_INVALID');
  }
  for (let index = 1; index < conflictDetails.length; index += 1) {
    const prior = conflictDetails[index - 1];
    const current = conflictDetails[index];
    if (prior === undefined || current === undefined
      || prior.start > current.start
      || (prior.start === current.start && prior.end > current.end)) {
      throw new Error('PREVIEW_RESPONSE_INVALID');
    }
  }
  return Object.freeze({
    outcome: value.outcome,
    detections: value.counts.detections,
    conflicts: value.counts.conflicts,
    byEntity: Object.freeze(byEntity),
    details: Object.freeze(details),
    detailsLimited: value.detailsLimited,
    conflictDetails: Object.freeze(conflictDetails),
    conflictDetailsLimited: value.conflictDetailsLimited
  });
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

interface ArtifactSummary {
  readonly id: string;
  readonly mediaType: 'text/plain' | 'text/markdown';
  readonly byteLength: number;
  readonly digest: string;
  readonly publicationState: 'STAGED' | 'IMMUTABLE';
}

function projectArtifact(value: unknown): ArtifactSummary {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'schemaVersion', 'id', 'kind', 'mediaType', 'byteLength', 'digest', 'displayName',
      'publicationState', 'createdAt', 'expiresAt'
    ])
    || value.schemaVersion !== '1.0.0'
    || typeof value.id !== 'string' || !artifactIdPattern.test(value.id)
    || value.kind !== 'INPUT'
    || (value.mediaType !== 'text/plain' && value.mediaType !== 'text/markdown')
    || !safeInteger(value.byteLength, 1, webPreviewMaximumInputBytes)
    || typeof value.digest !== 'string' || !digestPattern.test(value.digest)
    || typeof value.displayName !== 'string' || value.displayName.length > 255
    || (value.publicationState !== 'STAGED' && value.publicationState !== 'IMMUTABLE')
    || !dateTime(value.createdAt)
    || (value.expiresAt !== undefined && !dateTime(value.expiresAt))) {
    throw new Error('ARTIFACT_RESPONSE_INVALID');
  }
  return Object.freeze({
    id: value.id,
    mediaType: value.mediaType,
    byteLength: value.byteLength,
    digest: value.digest,
    publicationState: value.publicationState
  });
}

function projectOutputArtifact(value: unknown): Omit<RedactedOutputSummary, 'bytes'> {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'schemaVersion', 'id', 'kind', 'mediaType', 'byteLength', 'digest', 'displayName',
      'publicationState', 'createdAt', 'expiresAt'
    ])
    || value.schemaVersion !== '1.0.0'
    || typeof value.id !== 'string' || !artifactIdPattern.test(value.id)
    || value.kind !== 'SANITIZED_OUTPUT'
    || (value.mediaType !== 'text/plain' && value.mediaType !== 'text/markdown')
    || !safeInteger(value.byteLength, 0, webRedactionMaximumOutputBytes)
    || typeof value.digest !== 'string' || !digestPattern.test(value.digest)
    || (value.displayName !== 'document.redacted.txt' && value.displayName !== 'document.redacted.md')
    || (value.mediaType === 'text/plain') !== (value.displayName === 'document.redacted.txt')
    || value.publicationState !== 'PUBLISHABLE'
    || !dateTime(value.createdAt)
    || (value.expiresAt !== undefined && !dateTime(value.expiresAt))) {
    throw new Error('OUTPUT_RESPONSE_INVALID');
  }
  return Object.freeze({
    id: value.id,
    mediaType: value.mediaType,
    byteLength: value.byteLength,
    digest: value.digest,
    displayName: value.displayName
  });
}

export function projectDetectionPage(value: unknown, expectedJobId: string): DetectionPageSummary {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'schemaVersion', 'jobId', 'jobRevision', 'total', 'conflicts', 'byEntity',
      'cursor', 'nextCursor', 'detections', 'conflictDetails', 'conflictDetailsLimited'
    ])
    || value.schemaVersion !== '1.0.0'
    || value.jobId !== expectedJobId
    || !safeInteger(value.jobRevision, 1)
    || !safeInteger(value.total, 0, 10_000)
    || !safeInteger(value.conflicts, 0, 10_000)
    || !safeInteger(value.cursor, 0, 10_000)
    || (value.nextCursor !== null && !safeInteger(value.nextCursor, value.cursor + 1, 10_000))
    || !isRecord(value.byEntity)
    || Object.keys(value.byEntity).length > entityTypes.size
    || !Array.isArray(value.detections)
    || value.detections.length > 100
    || !Array.isArray(value.conflictDetails)
    || value.conflictDetails.length > 100
    || typeof value.conflictDetailsLimited !== 'boolean') {
    throw new Error('DETECTION_RESPONSE_INVALID');
  }
  const byEntity: Partial<Record<PreviewEntityType, number>> = {};
  let total = 0;
  for (const [entityType, count] of Object.entries(value.byEntity)) {
    if (!entityTypes.has(entityType as PreviewEntityType) || !safeInteger(count, 1, 10_000)) {
      throw new Error('DETECTION_RESPONSE_INVALID');
    }
    byEntity[entityType as PreviewEntityType] = count;
    total += count;
  }
  if (total !== value.total || value.cursor + value.detections.length > value.total
    || (value.nextCursor === null) !== (value.cursor + value.detections.length >= value.total)
    || (value.nextCursor !== null && value.nextCursor !== value.cursor + value.detections.length)) {
    throw new Error('DETECTION_RESPONSE_INVALID');
  }
  const details = value.detections.map((item): PreviewDetectionSummary => {
    if (!isRecord(item)
      || !hasOnlyKeys(item, ['id', 'entityType', 'start', 'end', 'offsetUnit', 'confidence', 'sources'])
      || typeof item.id !== 'string' || !uuidPattern.test(item.id)
      || typeof item.entityType !== 'string' || !entityTypes.has(item.entityType as PreviewEntityType)
      || !safeInteger(item.start, 0, 10_000_000)
      || !safeInteger(item.end, 1, 10_000_000) || item.start >= item.end
      || item.offsetUnit !== 'UNICODE_CODE_POINT'
      || typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1
      || !Array.isArray(item.sources) || item.sources.length < 1 || item.sources.length > detectionSources.size
      || item.sources.some((source) => typeof source !== 'string'
        || !detectionSources.has(source as PreviewDetectionSource))
      || new Set(item.sources).size !== item.sources.length) {
      throw new Error('DETECTION_RESPONSE_INVALID');
    }
    return Object.freeze({
      entityType: item.entityType as PreviewEntityType,
      start: item.start,
      end: item.end,
      confidence: item.confidence,
      sources: Object.freeze(item.sources as PreviewDetectionSource[])
    });
  });
  const conflictDetails = value.conflictDetails.map((item): PreviewConflictSummary => {
    if (!isRecord(item)
      || !hasOnlyKeys(item, ['code', 'start', 'end', 'offsetUnit', 'entityTypes', 'sources'])
      || item.code !== 'INCOMPATIBLE_OVERLAP'
      || !safeInteger(item.start, 0, 10_000_000)
      || !safeInteger(item.end, 1, 10_000_000) || item.start >= item.end
      || item.offsetUnit !== 'UNICODE_CODE_POINT'
      || !Array.isArray(item.entityTypes) || item.entityTypes.length < 1 || item.entityTypes.length > entityTypes.size
      || item.entityTypes.some((entityType) => typeof entityType !== 'string'
        || !entityTypes.has(entityType as PreviewEntityType))
      || new Set(item.entityTypes).size !== item.entityTypes.length
      || !Array.isArray(item.sources) || item.sources.length < 1 || item.sources.length > detectionSources.size
      || item.sources.some((source) => typeof source !== 'string'
        || !detectionSources.has(source as PreviewDetectionSource))
      || new Set(item.sources).size !== item.sources.length) {
      throw new Error('DETECTION_RESPONSE_INVALID');
    }
    return Object.freeze({
      code: item.code,
      start: item.start,
      end: item.end,
      entityTypes: Object.freeze(item.entityTypes as PreviewEntityType[]),
      sources: Object.freeze(item.sources as PreviewDetectionSource[])
    });
  });
  if (conflictDetails.length !== Math.min(value.conflicts, 100)
    || value.conflictDetailsLimited !== (value.conflicts > 100)) {
    throw new Error('DETECTION_RESPONSE_INVALID');
  }
  return Object.freeze({
    jobId: expectedJobId,
    jobRevision: value.jobRevision,
    detections: value.total,
    conflicts: value.conflicts,
    byEntity: Object.freeze(byEntity),
    cursor: value.cursor,
    nextCursor: value.nextCursor,
    details: Object.freeze(details),
    conflictDetails: Object.freeze(conflictDetails),
    conflictDetailsLimited: value.conflictDetailsLimited
  });
}

function mediaTypeForFile(file: File): 'text/plain' | 'text/markdown' {
  const separator = file.name.lastIndexOf('.');
  const extension = separator < 1 ? '' : file.name.slice(separator).toLowerCase();
  if (extension === '.txt') return 'text/plain';
  if (extension === '.md' || extension === '.markdown') return 'text/markdown';
  throw new TypeError('The scan file is invalid.');
}

function createIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

async function sha256Digest(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function waitForPoll(signal: AbortSignal, milliseconds: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      reject(new Error('JOB_REQUEST_CANCELLED'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function requestJson(
  origin: URL,
  bearerToken: string,
  fetchImplementation: typeof fetch,
  url: URL,
  init: Readonly<{
    readonly method: 'GET' | 'POST' | 'PUT';
    readonly body?: BodyInit;
    readonly contentType?: string;
    readonly idempotencyKey?: string;
  }>,
  signal: AbortSignal,
  maximumResponseBytes: number,
  invalidResponseCode: string,
  requestFailureCode = 'JOB_REQUEST_FAILED'
): Promise<unknown> {
  const response = await fetchImplementation(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${bearerToken}`,
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': init.contentType ?? 'application/json' }),
      ...(init.idempotencyKey === undefined ? {} : { 'idempotency-key': init.idempotencyKey })
    },
    ...(init.body === undefined ? {} : { body: init.body }),
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal
  });
  if (url.origin !== origin.origin || !response.ok) throw new Error(requestFailureCode);
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
  const uploadInput = async (
    file: File,
    onProgress: (state: ScanProgressState) => void,
    signal: AbortSignal
  ): Promise<ArtifactSummary> => {
    const mediaType = mediaTypeForFile(file);
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > webPreviewMaximumInputBytes) {
      throw new TypeError('The processing file is invalid.');
    }
    const bytes = await file.arrayBuffer();
    try {
      if (signal.aborted) throw new Error('JOB_REQUEST_CANCELLED');
      if (bytes.byteLength !== file.size) throw new Error('ARTIFACT_REQUEST_FAILED');
      const digest = await sha256Digest(bytes);
      onProgress('UPLOADING');
      const artifact = projectArtifact(await invoke(signal, async (operationSignal) => requestJson(
        origin, session.bearerToken, fetchImplementation, new URL('/v1/artifacts', origin),
        {
          method: 'POST',
          body: JSON.stringify({ schemaVersion: '1.0.0', mediaType, byteLength: bytes.byteLength, digest })
        },
        operationSignal,
        maximumJobResponseBytes,
        'ARTIFACT_RESPONSE_INVALID',
        'ARTIFACT_REQUEST_FAILED'
      )));
      if (artifact.mediaType !== mediaType || artifact.byteLength !== bytes.byteLength
        || artifact.digest !== digest || artifact.publicationState !== 'STAGED') {
        throw new Error('ARTIFACT_RESPONSE_INVALID');
      }
      const immutableArtifact = projectArtifact(await invoke(signal, async (operationSignal) => requestJson(
        origin,
        session.bearerToken,
        fetchImplementation,
        new URL(`/v1/artifacts/${artifact.id}/content`, origin),
        { method: 'PUT', body: bytes, contentType: 'application/octet-stream' },
        operationSignal,
        maximumJobResponseBytes,
        'ARTIFACT_RESPONSE_INVALID',
        'ARTIFACT_REQUEST_FAILED'
      )));
      if (immutableArtifact.id !== artifact.id || immutableArtifact.mediaType !== mediaType
        || immutableArtifact.byteLength !== bytes.byteLength || immutableArtifact.digest !== digest
        || immutableArtifact.publicationState !== 'IMMUTABLE') {
        throw new Error('ARTIFACT_RESPONSE_INVALID');
      }
      return immutableArtifact;
    } finally {
      new Uint8Array(bytes).fill(0);
    }
  };

  const client: LocalJobClient = {
    loadPolicies(signal) {
      return invoke(signal, async (operationSignal) => projectPolicyCatalog(await requestJson(
        origin, session.bearerToken, fetchImplementation, new URL('/v1/policies', origin),
        { method: 'GET' }, operationSignal, maximumPolicyResponseBytes, 'POLICY_RESPONSE_INVALID'
      )));
    },

    async scan(file, policy, onProgress, signal) {
      const trustedPolicy = projectPolicy(policy);
      const artifact = await uploadInput(file, onProgress, signal);
      const body = JSON.stringify({
        schemaVersion: '2.0.0',
        operation: 'SCAN',
        inputArtifactId: artifact.id,
        policy: { id: trustedPolicy.id, version: trustedPolicy.version, digest: trustedPolicy.digest }
      });
      let job = projectJob(await invoke(signal, async (operationSignal) => requestJson(
        origin, session.bearerToken, fetchImplementation, new URL('/v1/jobs', origin),
        { method: 'POST', body, idempotencyKey: createIdempotencyKey() },
        operationSignal, maximumJobResponseBytes, 'JOB_RESPONSE_INVALID'
      )));
      onProgress(job.state);
      const workflowDeadline = Date.now() + scanWorkflowTimeoutMs;
      while (job.state !== 'SUCCEEDED' && job.state !== 'NEEDS_REVIEW') {
        if (job.state === 'FAILED' || job.state === 'CANCELLED' || job.state === 'EXPIRED') {
          throw new Error('JOB_PROCESSING_FAILED');
        }
        if (Date.now() >= workflowDeadline) throw new Error('JOB_PROCESSING_TIMEOUT');
        await waitForPoll(signal, 75);
        job = await client.get(job.id, signal);
        onProgress(job.state);
      }
      const [eventPage, detectionPage] = await Promise.all([
        client.listEvents(job.id, 0, 100, signal),
        client.listDetections(job.id, 0, 100, signal)
      ]);
      if (detectionPage.jobRevision !== job.revision) throw new Error('DETECTION_RESPONSE_INVALID');
      return Object.freeze({
        ...detectionPage,
        outcome: job.state,
        job,
        events: eventPage.events
      });
    },

    async redact(file, policy, onProgress, signal) {
      const trustedPolicy = projectPolicy(policy);
      const artifact = await uploadInput(file, onProgress, signal);
      const body = JSON.stringify({
        schemaVersion: '3.0.0',
        operation: 'REDACT',
        inputArtifactId: artifact.id,
        policy: { id: trustedPolicy.id, version: trustedPolicy.version, digest: trustedPolicy.digest }
      });
      let job = projectJob(await invoke(signal, async (operationSignal) => requestJson(
        origin, session.bearerToken, fetchImplementation, new URL('/v1/jobs', origin),
        { method: 'POST', body, idempotencyKey: createIdempotencyKey() },
        operationSignal, maximumJobResponseBytes, 'JOB_RESPONSE_INVALID'
      )));
      if (job.operation !== 'REDACT') throw new Error('JOB_RESPONSE_INVALID');
      onProgress(job.state);
      const workflowDeadline = Date.now() + scanWorkflowTimeoutMs;
      while (job.state !== 'VERIFIED') {
        if (job.state === 'SUCCEEDED' || job.state === 'NEEDS_REVIEW'
          || job.state === 'FAILED' || job.state === 'CANCELLED' || job.state === 'EXPIRED') {
          throw new Error('JOB_PROCESSING_FAILED');
        }
        if (Date.now() >= workflowDeadline) throw new Error('JOB_PROCESSING_TIMEOUT');
        await waitForPoll(signal, 75);
        job = await client.get(job.id, signal);
        if (job.operation !== 'REDACT') throw new Error('JOB_RESPONSE_INVALID');
        onProgress(job.state);
      }
      const output = projectOutputArtifact(await invoke(signal, async (operationSignal) => requestJson(
        origin, session.bearerToken, fetchImplementation, jobUrl(job.id, '/output'),
        { method: 'GET' }, operationSignal, maximumJobResponseBytes, 'OUTPUT_RESPONSE_INVALID',
        'OUTPUT_REQUEST_FAILED'
      )));
      const outputUrl = new URL(`/v1/artifacts/${output.id}/content`, origin);
      const outputBytes = await invoke(signal, async (operationSignal) => {
        const response = await fetchImplementation(outputUrl, {
          method: 'GET',
          headers: { authorization: `Bearer ${session.bearerToken}`, accept: output.mediaType },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: operationSignal
        });
        if (outputUrl.origin !== origin.origin || !response.ok) throw new Error('OUTPUT_REQUEST_FAILED');
        const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
        if (mediaType !== output.mediaType) throw new Error('OUTPUT_RESPONSE_INVALID');
        return readBoundedResponseBytes(response, webRedactionMaximumOutputBytes, 'OUTPUT_RESPONSE_INVALID');
      });
      const digestBytes = outputBytes.slice();
      let downloadedDigest: string;
      try {
        downloadedDigest = await sha256Digest(digestBytes.buffer);
      } finally {
        digestBytes.fill(0);
      }
      if (outputBytes.byteLength !== output.byteLength || downloadedDigest !== output.digest) {
        outputBytes.fill(0);
        throw new Error('OUTPUT_RESPONSE_INVALID');
      }
      return Object.freeze({
        job,
        output: Object.freeze({ ...output, bytes: outputBytes })
      });
    },

    listDetections(jobId, cursor, limit, signal) {
      if (!safeInteger(cursor, 0, 10_000) || !safeInteger(limit, 1, 100)) {
        throw new TypeError('The detection page query is invalid.');
      }
      const url = jobUrl(jobId, '/detections');
      url.searchParams.set('cursor', String(cursor));
      url.searchParams.set('limit', String(limit));
      return invoke(signal, async (operationSignal) => projectDetectionPage(await requestJson(
        origin, session.bearerToken, fetchImplementation, url,
        { method: 'GET' }, operationSignal, maximumDetectionResponseBytes, 'DETECTION_RESPONSE_INVALID'
      ), jobId));
    },

    scanPreview(file, signal) {
      const separator = file.name.lastIndexOf('.');
      const extension = separator < 1 ? '' : file.name.slice(separator).toLowerCase();
      const format = extension === '.txt'
        ? 'text'
        : extension === '.md' || extension === '.markdown'
          ? 'markdown'
          : undefined;
      if (format === undefined
        || !Number.isSafeInteger(file.size)
        || file.size < 0
        || file.size > webPreviewMaximumInputBytes) {
        throw new TypeError('The preview file is invalid.');
      }
      const url = new URL('/v1/preview/review', origin);
      url.searchParams.set('format', format);
      return invoke(signal, async (operationSignal) => projectPreviewScan(await requestJson(
        origin, session.bearerToken, fetchImplementation, url,
        { method: 'POST', body: file, contentType: 'application/octet-stream' },
        operationSignal, maximumPreviewResponseBytes, 'PREVIEW_RESPONSE_INVALID', 'PREVIEW_REQUEST_FAILED'
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
    scan: unavailable,
    redact: unavailable,
    listDetections: unavailable,
    scanPreview: unavailable,
    create: unavailable,
    get: unavailable,
    listEvents: unavailable,
    cancel: unavailable
  };
}
