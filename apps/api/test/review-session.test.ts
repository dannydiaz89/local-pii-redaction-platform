import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateContract } from '@local-pii/contracts';
import type { TextProcessingApplication } from '@local-pii/core';
import { createLocalPolicyCatalog, localTextApplication } from '@local-pii/profile-local';

import {
  buildApi,
  createVolatileProcessingControl,
  generateLocalSessionToken,
  type ApiDependencies,
  type CapabilityManifest,
  type ProcessingControlPort
} from '../src/index.js';

type Api = ReturnType<typeof buildApi>;
type InjectResponse = Awaited<ReturnType<Api['inject']>>;
interface PolicyBinding {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}
interface ReviewSetBody {
  readonly jobId: string;
  readonly jobRevision: number;
  readonly extractionRevision: string;
  readonly reviewRevision: number;
  readonly digest: string;
  readonly decisions: readonly Readonly<Record<string, unknown>>[];
}
interface JobBody {
  readonly id: string;
  readonly state: string;
  readonly revision: number;
}
interface EventPageBody {
  readonly jobId: string;
  readonly nextCursor: number;
  readonly events: readonly Readonly<{ cursor: number; revision: number; type: string }>[];
}

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const errorSchemaId = 'https://local-pii.dev/schemas/common/errors/1.0.0';
const jobEventPageSchemaId = 'https://local-pii.dev/schemas/jobs/job-event-page/1.0.0';
const detectionPageSchemaId = 'https://local-pii.dev/schemas/jobs/detection-page/1.0.0';
const reviewSetSchemaId = 'https://local-pii.dev/schemas/jobs/review-set/1.0.0';
const sessionToken = 'A'.repeat(43);
const loopbackHost = '127.0.0.1';
// Planted document values. No response body, error envelope, or event payload may contain them.
const firstCanary = 'review-alpha@example.test';
const secondCanary = 'review-beta@example.test';
const documentText = `Synthetic review record: ${firstCanary} then ${secondCanary}.`;
const servers: Api[] = [];

function capabilityManifest(): CapabilityManifest {
  return JSON.parse(readFileSync(
    resolve(repositoryRoot, 'fixtures/contracts/valid/capability-rules-only-text.json'),
    'utf8'
  )) as CapabilityManifest;
}

function authorization(token = sessionToken): Readonly<Record<string, string>> {
  return { host: loopbackHost, authorization: `Bearer ${token}` };
}

function expectCanonicalError(response: InjectResponse): void {
  expect(validateContract(errorSchemaId, JSON.parse(response.body) as unknown).valid).toBe(true);
}

function expectNoDocumentValues(...bodies: readonly string[]): void {
  const serialized = bodies.join(' ');
  expect(serialized).not.toContain(firstCanary);
  expect(serialized).not.toContain(secondCanary);
  expect(serialized).not.toContain('review-alpha');
  expect(serialized).not.toContain('review-beta');
}

function policyBinding(catalog: ReturnType<typeof createLocalPolicyCatalog>): PolicyBinding {
  return {
    id: catalog.defaultPolicyId,
    version: catalog.policies[0].version,
    digest: catalog.policies[0].digest
  };
}

function server(
  application: TextProcessingApplication = localTextApplication,
  options: Parameters<typeof createVolatileProcessingControl>[2] = {}
): {
  readonly instance: Api;
  readonly processing: ProcessingControlPort;
  readonly policy: PolicyBinding;
} {
  const catalog = createLocalPolicyCatalog();
  const processing = createVolatileProcessingControl(application, catalog.policies, options);
  const built = {
    application: { getCapabilities: () => Promise.resolve(capabilityManifest()) },
    jobs: processing,
    processing,
    policies: { get: () => Promise.resolve(catalog) },
    preview: {
      scan: () => Promise.resolve({
        schemaVersion: '2.0.0' as const, operation: 'SCAN' as const, outcome: 'SUCCEEDED' as const,
        counts: { detections: 0, conflicts: 0, byEntity: {} },
        detections: [], detailsLimited: false, conflicts: [], conflictDetailsLimited: false
      })
    },
    readiness: { check: () => Promise.resolve() }
  } satisfies ApiDependencies;
  const instance = buildApi(built, { session: { bearerToken: sessionToken } });
  servers.push(instance);
  return { instance, processing, policy: policyBinding(catalog) };
}

async function initiate(instance: Api, content = documentText): Promise<InjectResponse> {
  const bytes = Buffer.from(content, 'utf8');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return instance.inject({
    method: 'POST', url: '/v1/artifacts', headers: authorization(),
    payload: { schemaVersion: '1.0.0', mediaType: 'text/plain', byteLength: bytes.length, digest }
  });
}

async function upload(instance: Api, content = documentText): Promise<string> {
  const bytes = Buffer.from(content, 'utf8');
  const initiated = await initiate(instance, content);
  expect(initiated.statusCode).toBe(201);
  const artifactId = initiated.json<{ readonly id: string }>().id;
  const uploaded = await instance.inject({
    method: 'PUT', url: `/v1/artifacts/${artifactId}/content`,
    headers: { ...authorization(), 'content-type': 'application/octet-stream' },
    payload: bytes
  });
  expect(uploaded.statusCode).toBe(200);
  return artifactId;
}

async function settle(instance: Api, jobId: string, terminal: readonly string[]): Promise<JobBody> {
  let job: JobBody = { id: jobId, state: 'QUEUED', revision: 1 };
  for (let attempt = 0; attempt < 200 && !terminal.includes(job.state); attempt += 1) {
    const response = await instance.inject({
      method: 'GET', url: `/v1/jobs/${jobId}`, headers: authorization()
    });
    expect(response.statusCode).toBe(200);
    job = response.json<JobBody>();
    if (!terminal.includes(job.state)) await new Promise((done) => setTimeout(done, 5));
  }
  return job;
}

async function createJob(
  instance: Api,
  payload: Readonly<Record<string, unknown>>
): Promise<InjectResponse> {
  return instance.inject({
    method: 'POST', url: '/v1/jobs',
    headers: { ...authorization(), 'idempotency-key': randomUUID() },
    payload
  });
}

async function completedScan(instance: Api, policy: PolicyBinding): Promise<{
  readonly jobId: string;
  readonly job: JobBody;
  readonly detectionIds: readonly string[];
  readonly review: ReviewSetBody;
}> {
  const created = await createJob(instance, {
    schemaVersion: '2.0.0', operation: 'SCAN', inputArtifactId: await upload(instance), policy
  });
  expect(created.statusCode).toBe(201);
  const jobId = created.json<JobBody>().id;
  const job = await settle(instance, jobId, ['SUCCEEDED', 'NEEDS_REVIEW', 'FAILED']);
  expect(job.state).toBe('SUCCEEDED');
  const detections = await instance.inject({
    method: 'GET', url: `/v1/jobs/${jobId}/detections`, headers: authorization()
  });
  expect(detections.statusCode).toBe(200);
  const page = detections.json<{ readonly detections: readonly { readonly id: string }[] }>();
  const reviewResponse = await instance.inject({
    method: 'GET', url: `/v1/jobs/${jobId}/review-decisions`, headers: authorization()
  });
  expect(reviewResponse.statusCode).toBe(200);
  expectNoDocumentValues(detections.body, reviewResponse.body);
  return {
    jobId,
    job,
    detectionIds: page.detections.map(({ id }) => id),
    review: reviewResponse.json<ReviewSetBody>()
  };
}

function decision(
  targetDetectionId: string,
  action: 'ACCEPT' | 'REJECT'
): Readonly<Record<string, unknown>> {
  return {
    clientDecisionId: randomUUID(),
    targetDetectionId,
    action,
    reasonCode: action === 'ACCEPT' ? 'CONFIRMED_BY_REVIEWER' : 'FALSE_POSITIVE'
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (instance) => instance.close()));
});

describe('local browser review session adversarial evidence', () => {
  it('refuses results, downloads, and review writes to a session token that is no longer current', async () => {
    const { instance, processing, policy } = server();
    const scan = await completedScan(instance, policy);
    const redaction = await createJob(instance, {
      schemaVersion: '3.0.0', operation: 'REDACT', inputArtifactId: await upload(instance), policy
    });
    expect(redaction.statusCode).toBe(201);
    const redactionJobId = redaction.json<JobBody>().id;
    expect((await settle(instance, redactionJobId, ['VERIFIED', 'FAILED'])).state).toBe('VERIFIED');
    const output = await instance.inject({
      method: 'GET', url: `/v1/jobs/${redactionJobId}/output`, headers: authorization()
    });
    expect(output.statusCode).toBe(200);
    const outputArtifactId = output.json<{ readonly id: string }>().id;

    // The launcher session ended and a new launch minted a different secret.
    const expiredToken = generateLocalSessionToken();
    expect(expiredToken).not.toBe(sessionToken);
    const expired = { host: loopbackHost, authorization: `Bearer ${expiredToken}` };
    const refused = await Promise.all([
      instance.inject({ method: 'GET', url: `/v1/jobs/${scan.jobId}`, headers: expired }),
      instance.inject({ method: 'GET', url: `/v1/jobs/${scan.jobId}/events`, headers: expired }),
      instance.inject({ method: 'GET', url: `/v1/jobs/${scan.jobId}/detections`, headers: expired }),
      instance.inject({ method: 'GET', url: `/v1/jobs/${scan.jobId}/review-decisions`, headers: expired }),
      instance.inject({
        method: 'POST', url: `/v1/jobs/${scan.jobId}/review-decisions`, headers: expired,
        payload: {
          schemaVersion: '1.0.0',
          expectedJobRevision: scan.job.revision,
          expectedExtractionRevision: scan.review.extractionRevision,
          expectedReviewRevision: 0,
          // A hostile body carrying a document value must never be echoed by the refusal.
          decisions: [{ ...decision(scan.detectionIds[0] ?? '', 'REJECT'), note: firstCanary }]
        }
      }),
      instance.inject({ method: 'GET', url: `/v1/jobs/${redactionJobId}/output`, headers: expired }),
      instance.inject({
        method: 'GET', url: `/v1/artifacts/${outputArtifactId}/content`, headers: expired
      }),
      instance.inject({ method: 'DELETE', url: `/v1/jobs/${redactionJobId}`, headers: expired }),
      instance.inject({ method: 'GET', url: `/v1/jobs/${scan.jobId}`, headers: { host: loopbackHost } })
    ]);

    for (const response of refused) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_DENIED', retryable: false } });
      expect(response.body).not.toContain(expiredToken);
      expect(response.body).not.toContain(sessionToken);
      expect(response.body).not.toContain(scan.jobId);
      expect(response.body).not.toContain(outputArtifactId);
      expectCanonicalError(response);
    }
    expectNoDocumentValues(...refused.map(({ body }) => body));

    // Nothing the expired session attempted was applied.
    const reviewAfter = await instance.inject({
      method: 'GET', url: `/v1/jobs/${scan.jobId}/review-decisions`, headers: authorization()
    });
    expect(reviewAfter.json<ReviewSetBody>()).toEqual(scan.review);
    const stillVerified = await instance.inject({
      method: 'GET', url: `/v1/jobs/${redactionJobId}`, headers: authorization()
    });
    expect(stillVerified.json()).toMatchObject({ state: 'VERIFIED' });
    const download = await instance.inject({
      method: 'GET', url: `/v1/artifacts/${outputArtifactId}/content`, headers: authorization()
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('Synthetic review record: [EMAIL_1] then [EMAIL_2].');

    // Ending the session itself destroys the retrievable result and output bytes.
    await instance.close();
    await expect(processing.downloadOutput(outputArtifactId, 'cor_test_expired')).resolves.toBeUndefined();
    await expect(processing.getReviewSet(scan.jobId, 'cor_test_expired'))
      .rejects.toMatchObject({ code: 'JOB_CONFLICT' });
  });

  it('resumes a dropped client on gapless job events and refuses a half-applied result view', async () => {
    let markStarted!: () => void;
    let releaseScan!: () => void;
    const scanStarted = new Promise<void>((done) => { markStarted = done; });
    const held = new Promise<void>((done) => { releaseScan = done; });
    const gated: TextProcessingApplication = {
      ...localTextApplication,
      async scan(command, context) {
        markStarted();
        await held;
        return localTextApplication.scan(command, context);
      }
    };
    const { instance, policy } = server(gated);
    const created = await createJob(instance, {
      schemaVersion: '2.0.0', operation: 'SCAN', inputArtifactId: await upload(instance), policy
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json<JobBody>().id;
    await scanStarted;

    // A connected client consumes the history one event at a time, then drops.
    const consumed: EventPageBody['events'][number][] = [];
    let cursor = 0;
    for (let request = 0; request < 10; request += 1) {
      const page = await instance.inject({
        method: 'GET', url: `/v1/jobs/${jobId}/events?after=${String(cursor)}&limit=1`,
        headers: authorization()
      });
      expect(page.statusCode).toBe(200);
      expect(validateContract(jobEventPageSchemaId, page.json()).valid).toBe(true);
      const body = page.json<EventPageBody>();
      if (body.events.length === 0) {
        expect(body.nextCursor).toBe(cursor);
        break;
      }
      consumed.push(...body.events);
      cursor = body.nextCursor;
    }
    expect(consumed.map(({ cursor: eventCursor }) => eventCursor)).toEqual([1, 2, 3, 4]);
    expect(consumed.map(({ type }) => type)).toEqual([
      'JOB_CREATED', 'STATE_CHANGED', 'STATE_CHANGED', 'STATE_CHANGED'
    ]);
    const inFlight = await instance.inject({
      method: 'GET', url: `/v1/jobs/${jobId}`, headers: authorization()
    });
    expect(inFlight.json()).toMatchObject({ state: 'DETECTING', revision: 4 });

    // Mid-job the client sees no partial result and cannot write review state against one.
    const midJob = await Promise.all([
      instance.inject({ method: 'GET', url: `/v1/jobs/${jobId}/detections`, headers: authorization() }),
      instance.inject({ method: 'GET', url: `/v1/jobs/${jobId}/review-decisions`, headers: authorization() }),
      instance.inject({
        method: 'POST', url: `/v1/jobs/${jobId}/review-decisions`, headers: authorization(),
        payload: {
          schemaVersion: '1.0.0', expectedJobRevision: 4,
          expectedExtractionRevision: `sha256:${'0'.repeat(64)}`, expectedReviewRevision: 0,
          decisions: [decision('123e4567-e89b-42d3-a456-426614174011', 'ACCEPT')]
        }
      })
    ]);
    for (const response of midJob) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'JOB_CONFLICT' } });
      expectCanonicalError(response);
    }
    expectNoDocumentValues(...midJob.map(({ body }) => body), inFlight.body);

    releaseScan();
    const settled = await settle(instance, jobId, ['SUCCEEDED', 'NEEDS_REVIEW', 'FAILED']);
    expect(settled).toMatchObject({ state: 'SUCCEEDED', revision: 6 });

    // The reconnecting client resumes from its own last cursor: no gap, no renumbering, no replay.
    const resumed = await instance.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/events?after=${String(cursor)}&limit=100`,
      headers: authorization()
    });
    expect(resumed.statusCode).toBe(200);
    const resumedBody = resumed.json<EventPageBody>();
    expect(resumedBody.events.map(({ cursor: eventCursor }) => eventCursor)).toEqual([5, 6]);
    expect(resumedBody.nextCursor).toBe(6);

    const full = await instance.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/events?after=0&limit=100`, headers: authorization()
    });
    const fullBody = full.json<EventPageBody>();
    expect(fullBody.events).toEqual([...consumed, ...resumedBody.events]);
    expect(fullBody.events.map(({ revision }) => revision)).toEqual([1, 2, 3, 4, 5, 6]);

    // Re-reading an already consumed range is stable rather than a moving window.
    const replayed = await instance.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/events?after=0&limit=4`, headers: authorization()
    });
    expect(replayed.json<EventPageBody>().events).toEqual(consumed);
    const beyond = await instance.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/events?after=6&limit=10`, headers: authorization()
    });
    expect(beyond.json()).toMatchObject({ nextCursor: 6, events: [] });

    // The detection page now pins the revision the resumed client must reconcile against.
    const detections = await instance.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/detections`, headers: authorization()
    });
    expect(detections.statusCode).toBe(200);
    expect(validateContract(detectionPageSchemaId, detections.json()).valid).toBe(true);
    expect(detections.json()).toMatchObject({ jobId, jobRevision: 6, total: 2 });
    expectNoDocumentValues(full.body, resumed.body, replayed.body, beyond.body, detections.body);
  });

  it('lets only one concurrent reviewer append and refuses the loser without a partial write', async () => {
    const { instance, policy } = server();
    const scan = await completedScan(instance, policy);
    const [firstDetection, secondDetection] = scan.detectionIds;
    expect(firstDetection).toBeDefined();
    expect(secondDetection).toBeDefined();
    const append = async (
      expectedReviewRevision: number,
      submitted: Readonly<Record<string, unknown>>
    ): Promise<InjectResponse> => instance.inject({
      method: 'POST', url: `/v1/jobs/${scan.jobId}/review-decisions`, headers: authorization(),
      payload: {
        schemaVersion: '1.0.0',
        expectedJobRevision: scan.job.revision,
        expectedExtractionRevision: scan.review.extractionRevision,
        expectedReviewRevision,
        decisions: [submitted]
      }
    });

    // Two reviewers read revision 0 and both write it back at the same time.
    const reviewerOne = decision(firstDetection ?? '', 'ACCEPT');
    const reviewerTwo = decision(firstDetection ?? '', 'REJECT');
    const [one, two] = await Promise.all([append(0, reviewerOne), append(0, reviewerTwo)]);
    const statuses = [one.statusCode, two.statusCode].sort((left, right) => left - right);
    expect(statuses).toEqual([200, 409]);
    const winner = one.statusCode === 200 ? one : two;
    const loser = one.statusCode === 200 ? two : one;
    const losingDecision = one.statusCode === 200 ? reviewerTwo : reviewerOne;
    expect(loser.json()).toMatchObject({ error: { code: 'JOB_CONFLICT', retryable: true } });
    expectCanonicalError(loser);
    expect(validateContract(reviewSetSchemaId, winner.json()).valid).toBe(true);

    const afterRace = await instance.inject({
      method: 'GET', url: `/v1/jobs/${scan.jobId}/review-decisions`, headers: authorization()
    });
    const raceResult = afterRace.json<ReviewSetBody>();
    expect(raceResult).toEqual(winner.json());
    expect(raceResult.reviewRevision).toBe(1);
    expect(raceResult.decisions).toHaveLength(1);
    // The loser's write left nothing behind at all.
    expect(afterRace.body).not.toContain(losingDecision.clientDecisionId as string);

    // The loser reconciles against the new revision; the winner's record is never rewritten.
    const retry = await append(raceResult.reviewRevision, losingDecision);
    expect(retry.statusCode).toBe(200);
    const reconciled = retry.json<ReviewSetBody>();
    expect(reconciled.reviewRevision).toBe(2);
    expect(reconciled.decisions[0]).toEqual(raceResult.decisions[0]);
    expect(reconciled.decisions[1]).toMatchObject({
      revision: 2,
      clientDecisionId: losingDecision.clientDecisionId,
      principal: 'LOCAL_SESSION'
    });
    expect(reconciled.digest).not.toBe(raceResult.digest);

    // A reviewer that lost its response but whose write landed replays safely on a stale revision.
    const replay = await append(0, losingDecision);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(reconciled);

    // Reusing a decision identifier for different content is refused, not silently merged.
    const reused = await append(reconciled.reviewRevision, {
      ...losingDecision,
      targetDetectionId: secondDetection,
      action: 'ACCEPT',
      reasonCode: 'CONFIRMED_BY_REVIEWER'
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });

    // A redaction bound to the review the loser had read is refused rather than silently rebased.
    const staleRedaction = await createJob(instance, {
      schemaVersion: '4.0.0', operation: 'REDACT', inputArtifactId: await upload(instance), policy,
      review: {
        sourceJobId: scan.jobId,
        expectedJobRevision: scan.job.revision,
        expectedExtractionRevision: scan.review.extractionRevision,
        expectedReviewRevision: scan.review.reviewRevision,
        expectedReviewDigest: scan.review.digest
      }
    });
    expect(staleRedaction.statusCode).toBe(409);
    expect(staleRedaction.json()).toMatchObject({ error: { code: 'JOB_CONFLICT' } });
    expectNoDocumentValues(
      one.body, two.body, afterRace.body, retry.body, replay.body, reused.body, staleRedaction.body
    );
  });

  it('releases the deleted job intake slot rather than only hiding the retained artifact', async () => {
    // A bounded session makes retention observable: a hidden-but-retained artifact keeps its slot.
    const { instance, policy } = server(localTextApplication, { maximumArtifacts: 2 });
    const scan = await completedScan(instance, policy);
    expect((await initiate(instance)).statusCode).toBe(201);
    const exhausted = await initiate(instance);
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json()).toMatchObject({ error: { code: 'RATE_LIMITED', retryable: true } });
    expectCanonicalError(exhausted);

    expect((await instance.inject({
      method: 'DELETE', url: `/v1/jobs/${scan.jobId}`, headers: authorization()
    })).statusCode).toBe(204);

    const reclaimed = await initiate(instance);
    expect(reclaimed.statusCode).toBe(201);
    expect(reclaimed.json()).toMatchObject({ publicationState: 'STAGED', displayName: 'document.txt' });
    expectNoDocumentValues(exhausted.body, reclaimed.body);
  });

  it('fails closed on every retrieval and write path after a deletion', async () => {
    const { instance, policy } = server();
    const scan = await completedScan(instance, policy);
    const accepted = await instance.inject({
      method: 'POST', url: `/v1/jobs/${scan.jobId}/review-decisions`, headers: authorization(),
      payload: {
        schemaVersion: '1.0.0',
        expectedJobRevision: scan.job.revision,
        expectedExtractionRevision: scan.review.extractionRevision,
        expectedReviewRevision: 0,
        decisions: [decision(scan.detectionIds[0] ?? '', 'ACCEPT')]
      }
    });
    expect(accepted.statusCode).toBe(200);
    const reviewSet = accepted.json<ReviewSetBody>();
    const binding = {
      sourceJobId: scan.jobId,
      expectedJobRevision: reviewSet.jobRevision,
      expectedExtractionRevision: reviewSet.extractionRevision,
      expectedReviewRevision: reviewSet.reviewRevision,
      expectedReviewDigest: reviewSet.digest
    };
    const redaction = await createJob(instance, {
      schemaVersion: '4.0.0', operation: 'REDACT', inputArtifactId: await upload(instance), policy,
      review: binding
    });
    expect(redaction.statusCode).toBe(201);
    const redactionJobId = redaction.json<JobBody>().id;
    expect((await settle(instance, redactionJobId, ['VERIFIED', 'FAILED'])).state).toBe('VERIFIED');
    const outputArtifactId = (await instance.inject({
      method: 'GET', url: `/v1/jobs/${redactionJobId}/output`, headers: authorization()
    })).json<{ readonly id: string }>().id;
    const beforeDeletion = await instance.inject({
      method: 'GET', url: `/v1/artifacts/${outputArtifactId}/content`, headers: authorization()
    });
    expect(beforeDeletion.statusCode).toBe(200);
    expect(beforeDeletion.body.length).toBeGreaterThan(0);

    const deletedRedaction = await instance.inject({
      method: 'DELETE', url: `/v1/jobs/${redactionJobId}`, headers: authorization()
    });
    expect(deletedRedaction.statusCode).toBe(204);
    expect(deletedRedaction.body).toBe('');
    const afterOutputDeletion = await Promise.all([
      instance.inject({ method: 'GET', url: `/v1/jobs/${redactionJobId}/output`, headers: authorization() }),
      instance.inject({
        method: 'GET', url: `/v1/artifacts/${outputArtifactId}/content`, headers: authorization()
      }),
      instance.inject({
        method: 'GET', url: '/v1/artifacts/art_01J4M91NJK8WAPJ7J95K73CB2Z/content', headers: authorization()
      })
    ]);
    expect(afterOutputDeletion.map(({ statusCode }) => statusCode)).toEqual([409, 404, 404]);
    // A deleted output is indistinguishable from an identifier that never existed.
    const envelope = (response: InjectResponse | undefined): unknown => {
      const body = response?.json<{
        readonly schemaVersion: string;
        readonly error: Readonly<Record<string, unknown>>;
      }>();
      if (body === undefined) return undefined;
      return {
        schemaVersion: body.schemaVersion,
        error: Object.fromEntries(Object.entries(body.error).filter(([key]) => key !== 'correlationId'))
      };
    };
    expect(envelope(afterOutputDeletion[1])).toEqual(envelope(afterOutputDeletion[2]));
    expect(envelope(afterOutputDeletion[1])).toMatchObject({
      error: { code: 'AUTHORIZATION_DENIED', message: 'The requested job is unavailable.' }
    });

    const deletedScan = await instance.inject({
      method: 'DELETE', url: `/v1/jobs/${scan.jobId}`, headers: authorization()
    });
    expect(deletedScan.statusCode).toBe(204);
    const afterScanDeletion = await Promise.all([
      instance.inject({ method: 'GET', url: `/v1/jobs/${scan.jobId}/detections`, headers: authorization() }),
      instance.inject({
        method: 'GET', url: `/v1/jobs/${scan.jobId}/review-decisions`, headers: authorization()
      }),
      instance.inject({
        method: 'POST', url: `/v1/jobs/${scan.jobId}/review-decisions`, headers: authorization(),
        payload: {
          schemaVersion: '1.0.0',
          expectedJobRevision: reviewSet.jobRevision,
          expectedExtractionRevision: reviewSet.extractionRevision,
          expectedReviewRevision: reviewSet.reviewRevision,
          decisions: [decision(scan.detectionIds[0] ?? '', 'REJECT')]
        }
      })
    ]);
    for (const response of afterScanDeletion) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'JOB_CONFLICT' } });
      expectCanonicalError(response);
    }
    const expiredJob = await instance.inject({
      method: 'GET', url: `/v1/jobs/${scan.jobId}`, headers: authorization()
    });
    expect(expiredJob.json()).toMatchObject({ id: scan.jobId, state: 'EXPIRED' });

    // A review binding captured before the deletion cannot revive the deleted decisions.
    const revived = await createJob(instance, {
      schemaVersion: '4.0.0', operation: 'REDACT', inputArtifactId: await upload(instance), policy,
      review: binding
    });
    expect(revived.statusCode).toBe(409);
    expect(revived.json()).toMatchObject({ error: { code: 'JOB_CONFLICT' } });

    // Deletion is idempotent and the session keeps working for new documents.
    expect((await instance.inject({
      method: 'DELETE', url: `/v1/jobs/${scan.jobId}`, headers: authorization()
    })).statusCode).toBe(204);
    const replacement = await completedScan(instance, policy);
    expect(replacement.jobId).not.toBe(scan.jobId);

    const events = await instance.inject({
      method: 'GET', url: `/v1/jobs/${scan.jobId}/events?after=0&limit=100`, headers: authorization()
    });
    expect(events.statusCode).toBe(200);
    expectNoDocumentValues(
      beforeDeletion.body,
      deletedRedaction.body,
      ...afterOutputDeletion.map(({ body }) => body),
      deletedScan.body,
      ...afterScanDeletion.map(({ body }) => body),
      expiredJob.body,
      revived.body,
      events.body
    );
  });
});
