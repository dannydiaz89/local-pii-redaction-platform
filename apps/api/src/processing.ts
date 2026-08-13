import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  localPreviewMaximumInputBytes,
  localRedactionMaximumOutputBytes,
  type ArtifactsArtifactContract,
  type ArtifactsCreateArtifactRequestV2Contract,
  type ArtifactsCreateArtifactRequestContract,
  type JobsDetectionPageContract,
  type JobsReviewDecisionRequestContract,
  type JobsReviewSetContract
} from '@local-pii/contracts';
import type {
  RedactionReviewSnapshot,
  TextArtifact,
  TextProcessingSession,
  TextProcessingApplication,
  TextRedactionResult,
  TextScanResult
} from '@local-pii/core';
import {
  canTransition,
  parseArtifactId,
  parseSha256Digest,
  SafeError,
  type EntityType
} from '@local-pii/domain';
import {
  createVolatileJobMetadataStore,
  type JobMetadataStore,
  type JobMutationResult
} from '@local-pii/job-store';
import {
  createEphemeralCsvArtifactSession,
  createEphemeralJsonArtifactSession,
  createEphemeralTextArtifactSession,
  csvCapabilityRequirement,
  decodeCsvArtifactBytes,
  decodeJsonArtifactBytes,
  decodeTextArtifactBytes,
  jsonCapabilityRequirement,
  resolveLocalPolicy,
  textCapabilityRequirement
} from '@local-pii/profile-local';

import {
  createJobControl,
  type CancelJobRequest,
  type CreateJobRequest,
  type Job,
  type JobControlPort,
  type JobEventPage,
  type LocalProcessingJobRequest,
  type ProcessingJobRequest,
  type ReviewedLocalRedactionJobRequest
} from './job-control.js';

export type Artifact = Readonly<ArtifactsArtifactContract.Artifact>;
export type CreateArtifactRequest =
  | Readonly<ArtifactsCreateArtifactRequestContract.CreateLocalArtifactRequest>
  | Readonly<ArtifactsCreateArtifactRequestV2Contract.CreateLocalArtifactRequestV2>;
type GeneratedDetectionPage = JobsDetectionPageContract.JobDetectionPage;
export type DetectionPage = Readonly<Omit<GeneratedDetectionPage, 'detections' | 'conflictDetails'>> & {
  readonly detections: readonly Readonly<GeneratedDetectionPage['detections'][number]>[];
  readonly conflictDetails: readonly Readonly<GeneratedDetectionPage['conflictDetails'][number]>[];
};
type Detection = DetectionPage['detections'][number];
export type AppendReviewDecisionsRequest = Readonly<JobsReviewDecisionRequestContract.AppendReviewDecisionsRequest>;
export type ReviewSet = Readonly<Omit<JobsReviewSetContract.ReviewSet, 'decisions'>> & {
  readonly decisions: readonly Readonly<JobsReviewSetContract.DecisionRecord>[];
};

export interface OutputArtifactDownload {
  readonly artifact: Artifact;
  readonly bytes: Uint8Array;
}

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
  getReviewSet(jobId: string, correlationId: string, signal?: AbortSignal): Promise<ReviewSet | undefined>;
  appendReviewDecisions(
    jobId: string,
    request: AppendReviewDecisionsRequest,
    correlationId: string,
    signal?: AbortSignal
  ): Promise<ReviewSet | undefined>;
  outputForJob(jobId: string, correlationId: string, signal?: AbortSignal): Promise<Artifact | undefined>;
  downloadOutput(
    artifactId: string,
    correlationId: string,
    signal?: AbortSignal
  ): Promise<OutputArtifactDownload | undefined>;
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
  readonly format: ArtifactFormat;
  bytes: Uint8Array | undefined;
}

type ArtifactFormat = 'text' | 'markdown' | 'json' | 'csv';

const unsupportedContainerSignatures = Object.freeze([
  Buffer.from('%PDF-', 'ascii'),
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
  Buffer.from([0x1f, 0x8b]),
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  Buffer.from('Rar!\u001a\u0007', 'binary')
]);

function hasUnsupportedContainerSignature(bytes: Uint8Array): boolean {
  return unsupportedContainerSignatures.some((signature) =>
    bytes.byteLength >= signature.byteLength
    && signature.every((byte, index) => bytes[index] === byte)
  );
}

interface JobResult {
  readonly inputDigest: string;
  readonly extractionRevision: string;
  readonly detections: readonly Detection[];
  readonly byEntity: Readonly<Partial<Record<EntityType, number>>>;
  readonly conflicts: number;
  readonly conflictDetails: readonly GeneratedDetectionPage['conflictDetails'][number][];
  readonly reviewTargets: readonly Readonly<{ readonly detectionId: string; readonly spanId: string }>[];
}

const crockfordBase32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const maximumUlidTimestamp = 281_474_976_710_655;
const defaultMaximumArtifacts = 8;
const defaultMaximumRetainedBytes = 32 * 1024 * 1024;
const maximumReviewDecisions = 1000;

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

function reviewDigest(
  jobId: string,
  jobRevision: number,
  extractionRevision: string,
  decisions: readonly Readonly<JobsReviewSetContract.DecisionRecord>[]
): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    schemaVersion: '1.0.0',
    jobId,
    jobRevision,
    extractionRevision,
    decisions
  }), 'utf8').digest('hex')}`;
}

function createReviewSet(
  job: Job,
  result: JobResult,
  decisions: readonly Readonly<JobsReviewSetContract.DecisionRecord>[]
): ReviewSet {
  const frozenDecisions = Object.freeze(decisions.map((decision) => Object.freeze({ ...decision })));
  return Object.freeze({
    schemaVersion: '1.0.0',
    jobId: job.id,
    jobRevision: job.revision,
    extractionRevision: result.extractionRevision,
    reviewRevision: frozenDecisions.length,
    digest: reviewDigest(job.id, job.revision, result.extractionRevision, frozenDecisions),
    decisions: frozenDecisions
  });
}

function sameSubmittedDecision(
  existing: Readonly<JobsReviewSetContract.DecisionRecord>,
  submitted: Readonly<JobsReviewDecisionRequestContract.Decision>
): boolean {
  return existing.clientDecisionId === submitted.clientDecisionId
    && existing.targetDetectionId === submitted.targetDetectionId
    && existing.action === submitted.action
    && existing.reasonCode === submitted.reasonCode
    && (existing.action !== 'RETYPE' || (submitted.action === 'RETYPE' && existing.entityType === submitted.entityType));
}

function formatFor(mediaType: CreateArtifactRequest['mediaType']): ArtifactFormat {
  if (mediaType === 'text/markdown') return 'markdown';
  if (mediaType === 'application/json') return 'json';
  if (mediaType === 'text/csv') return 'csv';
  return 'text';
}

function genericDisplayName(mediaType: CreateArtifactRequest['mediaType']): string {
  if (mediaType === 'text/markdown') return 'document.md';
  if (mediaType === 'application/json') return 'document.json';
  if (mediaType === 'text/csv') return 'document.csv';
  return 'document.txt';
}

function genericRedactedDisplayName(format: ArtifactFormat): string {
  if (format === 'markdown') return 'document.redacted.md';
  if (format === 'json') return 'document.redacted.json';
  if (format === 'csv') return 'document.redacted.csv';
  return 'document.redacted.txt';
}

function requirementFor(format: ArtifactFormat, operation: 'SCAN' | 'REDACT') {
  const requirement = format === 'json'
    ? jsonCapabilityRequirement(operation)
    : format === 'csv'
      ? csvCapabilityRequirement(operation)
      : textCapabilityRequirement(operation);
  return { ...requirement, maximumInputBytes: localPreviewMaximumInputBytes };
}

function decodeArtifact(
  bytes: Uint8Array,
  format: ArtifactFormat,
  policy: NonNullable<ReturnType<typeof resolveLocalPolicy>>
): TextArtifact {
  if (format === 'json') return decodeJsonArtifactBytes(bytes, localRedactionMaximumOutputBytes);
  if (format === 'csv') {
    return decodeCsvArtifactBytes(bytes, localRedactionMaximumOutputBytes, {
      delimiter: policy.structure.csv.delimiter,
      header: policy.structure.csv.header
    });
  }
  return decodeTextArtifactBytes(
    bytes,
    format === 'markdown' ? 'text/markdown' : 'text/plain',
    localRedactionMaximumOutputBytes
  );
}

interface EphemeralProcessingHandle {
  readonly session: TextProcessingSession;
  publishedBytes(): Uint8Array | undefined;
  dispose(): void;
}

function ephemeralSession(
  source: TextArtifact,
  format: ArtifactFormat,
  policy: NonNullable<ReturnType<typeof resolveLocalPolicy>>
): EphemeralProcessingHandle {
  if (format === 'json') {
    return createEphemeralJsonArtifactSession(source as ReturnType<typeof decodeJsonArtifactBytes>, localRedactionMaximumOutputBytes);
  }
  if (format === 'csv') {
    return createEphemeralCsvArtifactSession(
      source as ReturnType<typeof decodeCsvArtifactBytes>,
      localRedactionMaximumOutputBytes,
      { delimiter: policy.structure.csv.delimiter, header: policy.structure.csv.header }
    );
  }
  return createEphemeralTextArtifactSession(
    source as Parameters<typeof createEphemeralTextArtifactSession>[0],
    localRedactionMaximumOutputBytes
  );
}

function cloneArtifact(artifact: Artifact): Artifact {
  return Object.freeze({ ...artifact });
}

type DetectionBearingResult = Pick<TextScanResult, 'detectorBundleVersion' | 'evidence' | 'resolution'>
  | Pick<TextRedactionResult, 'detectorBundleVersion' | 'evidence' | 'resolution'>;

function stableDetectionId(result: DetectionBearingResult, spanId: string): string {
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

function resultForScan(
  result: DetectionBearingResult,
  inputDigest: string,
  correlationId: string
): JobResult {
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
    inputDigest,
    extractionRevision: result.resolution.extractionRevision,
    detections: Object.freeze(detections),
    byEntity: Object.freeze(byEntity),
    conflicts: result.resolution.conflicts.length,
    conflictDetails: Object.freeze(conflictDetails),
    reviewTargets: Object.freeze(result.resolution.spans.map((span) => Object.freeze({
      detectionId: stableDetectionId(result, span.id),
      spanId: span.id
    })))
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
  const outputByJob = new Map<string, string>();
  const artifactClaimByRequest = new Map<string, string>();
  const requestClaimByArtifact = new Map<string, string>();
  const results = new Map<string, JobResult>();
  const reviewHistories = new Map<string, readonly Readonly<JobsReviewSetContract.DecisionRecord>[]>();
  const reviewSnapshots = new Map<string, RedactionReviewSnapshot>();
  const controllers = new Map<string, AbortController>();
  const pending: string[] = [];
  let retainedBytes = 0;
  let activeWork: Promise<void> | undefined;
  let reviewMutation: Promise<void> = Promise.resolve();
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

  const removeArtifact = (artifactId: string | undefined): void => {
    if (artifactId === undefined) return;
    const artifact = artifacts.get(artifactId);
    if (artifact !== undefined) releaseArtifactBytes(artifact);
    artifacts.delete(artifactId);
    const requestClaim = requestClaimByArtifact.get(artifactId);
    requestClaimByArtifact.delete(artifactId);
    if (requestClaim !== undefined && artifactClaimByRequest.get(requestClaim) === artifactId) {
      artifactClaimByRequest.delete(requestClaim);
    }
  };

  const releaseJobResources = (jobId: string): void => {
    removeArtifact(outputByJob.get(jobId));
    removeArtifact(artifactByJob.get(jobId));
    outputByJob.delete(jobId);
    artifactByJob.delete(jobId);
    results.delete(jobId);
    reviewHistories.delete(jobId);
    reviewSnapshots.delete(jobId);
    controllers.delete(jobId);
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index] === jobId) pending.splice(index, 1);
    }
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
      let job = await store.get(jobId, correlationId);
      if (job === undefined) return;
      controller.signal.throwIfAborted();
      job = await transition(job, 'VALIDATING', correlationId);
      controller.signal.throwIfAborted();
      job = await transition(job, 'EXTRACTING', correlationId);
      job = await transition(job, 'DETECTING', correlationId);
      const policy = resolveLocalPolicy(job.policy);
      if (policy === undefined) {
        fail('POLICY_UNSATISFIABLE', 'The requested processing policy is unavailable.', false, correlationId);
      }
      const source = decodeArtifact(artifact.bytes, artifact.format, policy);
      if (job.operation === 'SCAN') {
        const scan = await application.scan({
          session: { input: () => Promise.resolve(source) },
          requirement: requirementFor(artifact.format, 'SCAN'),
          policy,
          signal: controller.signal
        }, { correlationId });
        controller.signal.throwIfAborted();
        job = await transition(job, 'RESOLVING', correlationId);
        const result = resultForScan(scan, scan.artifact.digest, correlationId);
        results.set(jobId, result);
        await transition(
          job,
          scan.outcome,
          correlationId,
          { detections: result.detections.length, conflicts: result.conflicts }
        );
      } else if (job.operation === 'REDACT') {
        job = await transition(job, 'RESOLVING', correlationId);
        job = await transition(job, 'REDACTING', correlationId);
        const handle = ephemeralSession(source, artifact.format, policy);
        const reviewSnapshot = reviewSnapshots.get(jobId);
        let detachedOutput: Uint8Array | undefined;
        let outputRetained = false;
        try {
          const redaction = await application.redact({
            session: handle.session,
            requirement: requirementFor(artifact.format, 'REDACT'),
            policy,
            ...(reviewSnapshot === undefined ? {} : { review: reviewSnapshot }),
            signal: controller.signal
          }, { correlationId });
          controller.signal.throwIfAborted();
          job = await transition(job, 'VERIFYING', correlationId);
          detachedOutput = handle.publishedBytes();
          if (detachedOutput === undefined
            || detachedOutput.byteLength !== redaction.published.byteLength
            || digestBytes(detachedOutput) !== redaction.published.digest) {
            fail('ARTIFACT_DIGEST_MISMATCH', 'The verified output could not be reconciled.', false, correlationId);
          }
          if (retainedBytes + detachedOutput.byteLength > maximumRetainedBytes) {
            fail('RATE_LIMITED', 'The local processing session has reached its byte limit.', true, correlationId);
          }
          const createdAt = now();
          const outputId = createArtifactId(createdAt, randomArtifactBytes());
          const output: ArtifactRecord = {
            metadata: Object.freeze({
              schemaVersion: '1.0.0',
              id: outputId,
              kind: 'SANITIZED_OUTPUT',
              mediaType: artifact.metadata.mediaType,
              byteLength: detachedOutput.byteLength,
              digest: redaction.published.digest,
              displayName: genericRedactedDisplayName(artifact.format),
              publicationState: 'PUBLISHABLE',
              createdAt: createdAt.toISOString()
            }),
            expectedDigest: redaction.published.digest,
            format: artifact.format,
            bytes: detachedOutput
          };
          const result = resultForScan(redaction, redaction.input.digest, correlationId);
          await transition(
            job,
            'VERIFIED',
            correlationId,
            { detections: result.detections.length, conflicts: result.conflicts }
          );
          retainedBytes += detachedOutput.byteLength;
          artifacts.set(outputId, output);
          outputByJob.set(jobId, outputId);
          results.set(jobId, result);
          outputRetained = true;
        } finally {
          if (!outputRetained) detachedOutput?.fill(0);
          handle.dispose();
        }
      } else {
        fail('CONTRACT_UNSUPPORTED', 'The requested processing operation is unavailable.', false, correlationId);
      }
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

  const mutateReview = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const turn = reviewMutation.then(operation, operation);
    reviewMutation = turn.then(() => undefined, () => undefined);
    return turn;
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
      if (hasUnsupportedContainerSignature(bytes)) {
        artifacts.delete(artifactId);
        fail('FORMAT_UNSUPPORTED', 'The uploaded artifact format is unavailable in this local API profile.', false, correlationId);
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
      const createProcessingJob = async (): Promise<JobMutationResult> => {
        let reviewSnapshot: RedactionReviewSnapshot | undefined;
        if (request.schemaVersion === '4.0.0') {
          const sourceJob = await jobs.get(request.review.sourceJobId, correlationId, signal);
          const sourceResult = results.get(request.review.sourceJobId);
          if (sourceJob?.operation !== 'SCAN'
            || (sourceJob.state !== 'SUCCEEDED' && sourceJob.state !== 'NEEDS_REVIEW')
            || sourceResult === undefined
            || sourceResult.conflicts !== 0
            || sourceJob.revision !== request.review.expectedJobRevision
            || sourceResult.extractionRevision !== request.review.expectedExtractionRevision
            || sourceJob.policy.id !== request.policy.id
            || sourceJob.policy.version !== request.policy.version
            || sourceJob.policy.digest !== request.policy.digest) {
            fail('JOB_CONFLICT', 'The reviewed scan no longer matches this request.', false, correlationId);
          }
          const history = reviewHistories.get(sourceJob.id) ?? [];
          const reviewSet = createReviewSet(sourceJob, sourceResult, history);
          if (reviewSet.reviewRevision !== request.review.expectedReviewRevision
            || reviewSet.digest !== request.review.expectedReviewDigest) {
            fail('JOB_CONFLICT', 'The reviewed scan no longer matches this request.', false, correlationId);
          }
          const targetByDetectionId = new Map(
            sourceResult.reviewTargets.map(({ detectionId, spanId }) => [detectionId, spanId])
          );
          const effective = new Map<string, Readonly<JobsReviewSetContract.DecisionRecord>>();
          for (const decision of history) effective.set(decision.targetDetectionId, decision);
          const decisions = [...effective.values()].map((decision) => {
            const sourceSpanId = targetByDetectionId.get(decision.targetDetectionId);
            if (sourceSpanId === undefined) {
              fail('JOB_CONFLICT', 'The reviewed detection is unavailable.', false, correlationId);
            }
            return decision.action === 'RETYPE'
              ? Object.freeze({ sourceSpanId, action: decision.action, entityType: decision.entityType })
              : Object.freeze({ sourceSpanId, action: decision.action });
          });
          reviewSnapshot = Object.freeze({
            binding: Object.freeze({
              extractionRevision: parseSha256Digest(reviewSet.extractionRevision),
              revision: reviewSet.reviewRevision,
              decisionCount: reviewSet.decisions.length,
              digest: parseSha256Digest(reviewSet.digest)
            }),
            decisions: Object.freeze(decisions)
          });
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
        if (request.schemaVersion === '4.0.0'
          && reviewSnapshot !== undefined
          && results.get(request.review.sourceJobId)?.inputDigest !== artifact.metadata.digest) {
          fail('JOB_CONFLICT', 'The reviewed scan no longer matches this request.', false, correlationId);
        }
        if (request.operation === 'REDACT' && artifacts.size >= maximumArtifacts) {
          fail('RATE_LIMITED', 'The local processing session has reached its artifact limit.', true, correlationId);
        }
        const requestClaim = `${idempotencyScope}\u0000${idempotencyKey}`;
        const priorArtifactForRequest = artifactClaimByRequest.get(requestClaim);
        if (priorArtifactForRequest !== undefined && priorArtifactForRequest !== artifactId) {
          fail('IDEMPOTENCY_CONFLICT', 'The request key was already used for a different artifact.', false, correlationId);
        }
        const priorRequestForArtifact = requestClaimByArtifact.get(artifactId);
        if (priorRequestForArtifact !== undefined && priorRequestForArtifact !== requestClaim) {
          fail('JOB_CONFLICT', 'The artifact is already bound to a processing job.', false, correlationId);
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
          if (reviewSnapshot !== undefined) reviewSnapshots.set(result.job.id, reviewSnapshot);
          controllers.set(result.job.id, new AbortController());
          pending.push(result.job.id);
          queueMicrotask(pump);
        }
        return result;
      };
      return request.schemaVersion === '4.0.0'
        ? mutateReview(createProcessingJob)
        : createProcessingJob();
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

    expire(jobId, correlationId, signal) {
      return mutateReview(async () => {
        signal?.throwIfAborted();
        if (closed) fail('STORAGE_UNAVAILABLE', 'The local processing session is unavailable.', true, correlationId);
        const job = await jobs.expire(jobId, correlationId, signal);
        if (job?.state === 'EXPIRED') releaseJobResources(jobId);
        return job;
      });
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
      if (result === undefined
        || (job.state !== 'SUCCEEDED' && job.state !== 'NEEDS_REVIEW' && job.state !== 'VERIFIED')) {
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

    async getReviewSet(jobId, correlationId, signal) {
      signal?.throwIfAborted();
      const job = await jobs.get(jobId, correlationId, signal);
      if (job === undefined) return undefined;
      const result = results.get(jobId);
      if (job.operation !== 'SCAN' || result === undefined
        || (job.state !== 'SUCCEEDED' && job.state !== 'NEEDS_REVIEW')) {
        fail('JOB_CONFLICT', 'The scan review is not available yet.', true, correlationId);
      }
      return createReviewSet(job, result, reviewHistories.get(jobId) ?? []);
    },

    appendReviewDecisions(jobId, request, correlationId, signal) {
      return mutateReview(async () => {
        signal?.throwIfAborted();
        if (closed) fail('STORAGE_UNAVAILABLE', 'The local processing session is unavailable.', true, correlationId);
        const job = await jobs.get(jobId, correlationId, signal);
        if (job === undefined) return undefined;
        const result = results.get(jobId);
        if (job.operation !== 'SCAN' || result === undefined
          || (job.state !== 'SUCCEEDED' && job.state !== 'NEEDS_REVIEW')) {
          fail('JOB_CONFLICT', 'The scan review is not available yet.', true, correlationId);
        }
        const current = reviewHistories.get(jobId) ?? [];
        const existingByClientId = new Map(current.map((decision) => [decision.clientDecisionId, decision]));
        const replayed = request.decisions.map((decision) => {
          const existing = existingByClientId.get(decision.clientDecisionId);
          if (existing === undefined) return false;
          if (!sameSubmittedDecision(existing, decision)) {
            fail('IDEMPOTENCY_CONFLICT', 'The review decision identifier was already used.', false, correlationId);
          }
          return true;
        });
        if (replayed.every(Boolean)) return createReviewSet(job, result, current);
        if (replayed.some(Boolean)) {
          fail('IDEMPOTENCY_CONFLICT', 'The review decision batch cannot be partially replayed.', false, correlationId);
        }
        if (job.revision !== request.expectedJobRevision
          || result.extractionRevision !== request.expectedExtractionRevision
          || current.length !== request.expectedReviewRevision) {
          fail('JOB_CONFLICT', 'The review revision changed.', true, correlationId);
        }
        if (current.length + request.decisions.length > maximumReviewDecisions) {
          fail('RATE_LIMITED', 'The local review session has reached its decision limit.', false, correlationId);
        }
        const knownDetectionIds = new Set(result.detections.map(({ id }) => id));
        const clientIds = new Set<string>();
        for (const decision of request.decisions) {
          if (!knownDetectionIds.has(decision.targetDetectionId)) {
            fail('JOB_CONFLICT', 'The reviewed detection is unavailable.', false, correlationId);
          }
          if (clientIds.has(decision.clientDecisionId)) {
            fail('IDEMPOTENCY_CONFLICT', 'The review decision identifier was repeated.', false, correlationId);
          }
          clientIds.add(decision.clientDecisionId);
        }
        const occurredAt = now().toISOString();
        const appended = request.decisions.map((decision, index) => Object.freeze({
          revision: current.length + index + 1,
          ...decision,
          principal: 'LOCAL_SESSION' as const,
          occurredAt
        }));
        const next = Object.freeze([...current, ...appended]);
        reviewHistories.set(jobId, next);
        signal?.throwIfAborted();
        return createReviewSet(job, result, next);
      });
    },

    async outputForJob(jobId, correlationId, signal) {
      signal?.throwIfAborted();
      const job = await jobs.get(jobId, correlationId, signal);
      if (job === undefined) return undefined;
      const outputId = outputByJob.get(jobId);
      const output = outputId === undefined ? undefined : artifacts.get(outputId);
      if (job.operation !== 'REDACT' || job.state !== 'VERIFIED' || output === undefined) {
        fail('JOB_CONFLICT', 'The verified output is not available yet.', true, correlationId);
      }
      return cloneArtifact(output.metadata);
    },

    downloadOutput(artifactIdInput, correlationId, signal) {
      signal?.throwIfAborted();
      const artifactId = parseArtifactId(artifactIdInput);
      const output = artifacts.get(artifactId);
      if (output?.metadata.kind !== 'SANITIZED_OUTPUT'
        || output.metadata.publicationState !== 'PUBLISHABLE'
        || output.bytes === undefined
        || ![...outputByJob.values()].includes(artifactId)) {
        return Promise.resolve(undefined);
      }
      if (output.bytes.byteLength !== output.metadata.byteLength
        || digestBytes(output.bytes) !== output.metadata.digest) {
        fail('ARTIFACT_DIGEST_MISMATCH', 'The verified output could not be reconciled.', false, correlationId);
      }
      signal?.throwIfAborted();
      return Promise.resolve(Object.freeze({
        artifact: cloneArtifact(output.metadata),
        bytes: Uint8Array.from(output.bytes)
      }));
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers.values()) controller.abort();
      if (activeWork !== undefined) await activeWork;
      await reviewMutation;
      for (const artifact of artifacts.values()) releaseArtifactBytes(artifact);
      artifacts.clear();
      artifactByJob.clear();
      outputByJob.clear();
      artifactClaimByRequest.clear();
      requestClaimByArtifact.clear();
      results.clear();
      reviewHistories.clear();
      reviewSnapshots.clear();
      pending.splice(0);
    }
  };
  return Object.freeze(control);
}

export function isProcessingJobRequest(
  request: CreateJobRequest
): request is ProcessingJobRequest | LocalProcessingJobRequest | ReviewedLocalRedactionJobRequest {
  return request.schemaVersion === '2.0.0' || request.schemaVersion === '3.0.0' || request.schemaVersion === '4.0.0';
}
