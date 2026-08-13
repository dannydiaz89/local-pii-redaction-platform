import { describe, expect, it } from 'vitest';
import { SafeError } from '@local-pii/domain';

import {
  createVolatileJobMetadataStore,
  validateJobOutboxAcknowledgement,
  validateJobOutboxClaim,
  validateJobOutboxClaimCompletion,
  validateJobOutboxClaimFailure,
  validateJobOutboxQuery,
  type CreateJobCommand,
  type JobMetadataStore
} from '../src/index.js';

const jobId = 'job_01J4M91NJK8WAPJ7J95K73CB2M';
const correlationId = 'cor_synthetic_job_store';
const firstEventId = '603df129-c778-4b13-8b2a-0fe745593c8f';
const secondEventId = '703df129-c778-4b13-8b2a-0fe745593c8f';
const thirdEventId = '803df129-c778-4b13-8b2a-0fe745593c8f';
const consumerId = '903df129-c778-4b13-8b2a-0fe745593c8f';
const requestDigest = `sha256:${'a'.repeat(64)}`;

function createCommand(overrides: Partial<CreateJobCommand> = {}): CreateJobCommand {
  return {
    jobId,
    operation: 'SCAN',
    policy: {
      id: 'development-labels',
      version: '0.1.0',
      digest: `sha256:${'b'.repeat(64)}`
    },
    now: '2026-08-09T18:00:00Z',
    expiresAt: '2026-08-10T18:00:00Z',
    eventId: firstEventId,
    idempotency: { scope: 'local-session', key: 'request-1', requestDigest },
    correlationId,
    ...overrides
  };
}

async function createdStore(): Promise<JobMetadataStore> {
  const store = createVolatileJobMetadataStore();
  await store.create(createCommand());
  return store;
}

async function expectSafeError(operation: Promise<unknown>, code: SafeError['code'], retryable: boolean): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SafeError);
    expect(error).toMatchObject({ code, retryable, correlationId });
    return;
  }
  throw new Error(`Expected ${code}`);
}

function expectSynchronousSafeError(operation: () => unknown, code: SafeError['code']): void {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SafeError);
    expect(error).toMatchObject({ code, retryable: false, correlationId });
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('volatile job metadata store conformance', () => {
  it('creates a canonical queued aggregate and an atomic value-free event', async () => {
    const store = createVolatileJobMetadataStore();
    const result = await store.create(createCommand());

    expect(result).toEqual({
      replayed: false,
      job: {
        schemaVersion: '1.0.0',
        id: jobId,
        operation: 'SCAN',
        state: 'QUEUED',
        revision: 1,
        policy: {
          id: 'development-labels',
          version: '0.1.0',
          digest: `sha256:${'b'.repeat(64)}`
        },
        createdAt: '2026-08-09T18:00:00Z',
        updatedAt: '2026-08-09T18:00:00Z',
        expiresAt: '2026-08-10T18:00:00Z'
      },
      event: {
        schemaVersion: '1.0.0',
        id: firstEventId,
        jobId,
        cursor: 1,
        revision: 1,
        type: 'JOB_CREATED',
        occurredAt: '2026-08-09T18:00:00Z'
      }
    });
    expect(Object.isFrozen(result.job)).toBe(true);
    expect(await store.listEvents({ jobId, correlationId })).toEqual([result.event]);
  });

  it('replays the same creation without duplicating a job or event', async () => {
    const store = createVolatileJobMetadataStore();
    const first = await store.create(createCommand());
    const replay = await store.create(createCommand({
      jobId: 'job_01J4M91NJK8WAPJ7J95K73CB2N',
      eventId: secondEventId
    }));

    expect(replay).toMatchObject({ replayed: true, job: { id: first.job.id }, event: first.event });
    expect(await store.listEvents({ jobId, correlationId })).toHaveLength(1);
  });

  it('replays the original creation result after the live aggregate advances', async () => {
    const store = createVolatileJobMetadataStore();
    await store.create(createCommand());
    await store.transition({
      jobId,
      expectedRevision: 1,
      to: 'VALIDATING',
      now: '2026-08-09T18:01:00Z',
      eventId: secondEventId,
      correlationId
    });

    const replay = await store.create(createCommand());
    expect(replay).toMatchObject({ replayed: true, job: { revision: 1 }, event: { revision: 1 } });
    expect((await store.get(jobId, correlationId))?.revision).toBe(2);
  });

  it('rejects reuse of an idempotency key with different metadata', async () => {
    const store = createVolatileJobMetadataStore();
    await store.create(createCommand());

    await expectSafeError(store.create(createCommand({
      idempotency: {
        scope: 'local-session',
        key: 'request-1',
        requestDigest: `sha256:${'c'.repeat(64)}`
      }
    })), 'IDEMPOTENCY_CONFLICT', false);
    expect(await store.listEvents({ jobId, correlationId })).toHaveLength(1);
  });

  it('increments revision and cursor together through canonical transitions', async () => {
    const store = await createdStore();
    const validating = await store.transition({
      jobId,
      expectedRevision: 1,
      to: 'VALIDATING',
      now: '2026-08-09T18:01:00Z',
      eventId: secondEventId,
      correlationId
    });
    const extracting = await store.transition({
      jobId,
      expectedRevision: 2,
      to: 'EXTRACTING',
      now: '2026-08-09T18:02:00Z',
      eventId: thirdEventId,
      summary: { detections: 0, conflicts: 0 },
      correlationId
    });

    expect(validating).toMatchObject({ job: { state: 'VALIDATING', revision: 2 }, event: { cursor: 2, revision: 2, type: 'STATE_CHANGED' } });
    expect(extracting).toMatchObject({ job: { state: 'EXTRACTING', revision: 3 }, event: { cursor: 3, revision: 3, counts: { detections: 0, conflicts: 0 } } });
    expect((await store.listEvents({ jobId, afterCursor: 1, limit: 2, correlationId })).map(({ cursor }) => cursor)).toEqual([2, 3]);
  });

  it('rejects stale revisions and forbidden state changes without appending events', async () => {
    const store = await createdStore();
    await store.transition({
      jobId,
      expectedRevision: 1,
      to: 'VALIDATING',
      now: '2026-08-09T18:01:00Z',
      eventId: secondEventId,
      correlationId
    });

    await expectSafeError(store.transition({
      jobId,
      expectedRevision: 1,
      to: 'EXTRACTING',
      now: '2026-08-09T18:02:00Z',
      eventId: thirdEventId,
      correlationId
    }), 'JOB_CONFLICT', true);
    await expectSafeError(store.transition({
      jobId,
      expectedRevision: 2,
      to: 'SUCCEEDED',
      now: '2026-08-09T18:02:00Z',
      eventId: thirdEventId,
      correlationId
    }), 'JOB_CONFLICT', false);

    expect((await store.get(jobId, correlationId))?.revision).toBe(2);
    expect(await store.listEvents({ jobId, correlationId })).toHaveLength(2);
  });

  it('admits only one concurrent mutation for the same expected revision', async () => {
    const store = await createdStore();
    const results = await Promise.allSettled([
      store.transition({
        jobId,
        expectedRevision: 1,
        to: 'VALIDATING',
        now: '2026-08-09T18:01:00Z',
        eventId: secondEventId,
        correlationId
      }),
      store.transition({
        jobId,
        expectedRevision: 1,
        to: 'CANCELLING',
        now: '2026-08-09T18:01:00Z',
        eventId: thirdEventId,
        correlationId
      })
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find(({ status }) => status === 'rejected');
    expect(rejection).toMatchObject({ reason: { code: 'JOB_CONFLICT', retryable: true } });
    expect(await store.listEvents({ jobId, correlationId })).toHaveLength(2);
  });

  it('rejects duplicate event identifiers without changing the aggregate', async () => {
    const store = await createdStore();
    await expectSafeError(store.transition({
      jobId,
      expectedRevision: 1,
      to: 'VALIDATING',
      now: '2026-08-09T18:01:00Z',
      eventId: firstEventId,
      correlationId
    }), 'JOB_CONFLICT', false);

    expect((await store.get(jobId, correlationId))?.revision).toBe(1);
    expect(await store.listEvents({ jobId, correlationId })).toHaveLength(1);
  });

  it('emits specialized minimized event types without retaining source-shaped properties', async () => {
    const store = await createdStore();
    const cancellation = await store.transition({
      jobId,
      expectedRevision: 1,
      to: 'CANCELLING',
      now: '2026-08-09T18:01:00Z',
      eventId: secondEventId,
      correlationId
    });

    expect(cancellation.event.type).toBe('CANCELLATION_REQUESTED');
    const serialized = JSON.stringify({ job: cancellation.job, event: cancellation.event });
    for (const prohibited of ['filename', 'path', 'text', 'content', 'excerpt', 'value']) {
      expect(serialized).not.toContain(prohibited);
    }
  });

  it('fails closed on malformed metadata and bounded event queries', async () => {
    const store = createVolatileJobMetadataStore();
    await expectSafeError(store.create(createCommand({
      policy: { id: 'development labels', version: 'not-semver', digest: requestDigest }
    })), 'SCHEMA_INVALID', false);
    await expectSafeError(store.listEvents({ jobId, limit: 101, correlationId }), 'SCHEMA_INVALID', false);
  });

  it('validates bounded outbox pagination and event-revision acknowledgements', () => {
    expect(validateJobOutboxQuery({ afterCursor: 4, limit: 25, correlationId }))
      .toEqual({ afterCursor: 4, limit: 25 });
    expect(validateJobOutboxAcknowledgement({
      eventId: firstEventId,
      revision: 1,
      acknowledgedAt: '2026-08-09T18:02:00Z',
      correlationId
    })).toEqual({
      eventId: firstEventId,
      revision: 1,
      acknowledgedAt: '2026-08-09T18:02:00Z'
    });
    expectSynchronousSafeError(
      () => validateJobOutboxQuery({ limit: 101, correlationId }),
      'SCHEMA_INVALID'
    );
    expectSynchronousSafeError(() => validateJobOutboxAcknowledgement({
      eventId: firstEventId,
      revision: 0,
      acknowledgedAt: '2026-08-09T18:02:00Z',
      correlationId
    }), 'SCHEMA_INVALID');
    expect(validateJobOutboxClaim({
      consumerId,
      now: '2026-08-09T18:02:00Z',
      leaseExpiresAt: '2026-08-09T18:07:00Z',
      limit: 10,
      correlationId
    })).toEqual({
      consumerId,
      now: '2026-08-09T18:02:00Z',
      leaseExpiresAt: '2026-08-09T18:07:00Z',
      limit: 10
    });
    expect(validateJobOutboxClaimCompletion({
      eventId: firstEventId,
      revision: 1,
      consumerId,
      attempt: 1,
      acknowledgedAt: '2026-08-09T18:03:00Z',
      correlationId
    })).toMatchObject({ consumerId, attempt: 1 });
    expect(validateJobOutboxClaimFailure({
      eventId: firstEventId,
      revision: 1,
      consumerId,
      attempt: 1,
      failedAt: '2026-08-09T18:03:00Z',
      retryAt: '2026-08-09T18:04:00Z',
      correlationId
    })).toMatchObject({ attempt: 1, retryAt: '2026-08-09T18:04:00Z' });
    expectSynchronousSafeError(() => validateJobOutboxClaim({
      consumerId,
      now: '2026-08-09T18:02:00Z',
      leaseExpiresAt: '2026-08-09T18:07:01Z',
      correlationId
    }), 'SCHEMA_INVALID');
    expectSynchronousSafeError(() => validateJobOutboxClaimFailure({
      eventId: firstEventId,
      revision: 1,
      consumerId,
      attempt: 6,
      failedAt: '2026-08-09T18:03:00Z',
      retryAt: '2026-08-10T18:03:01Z',
      correlationId
    }), 'SCHEMA_INVALID');
  });

  it('does not expose mutable references to stored metadata', async () => {
    const store = await createdStore();
    const read = await store.get(jobId, correlationId);
    expect(read).toBeDefined();
    expect(() => {
      (read as { state: string }).state = 'FAILED';
    }).toThrow(TypeError);
    expect((await store.get(jobId, correlationId))?.state).toBe('QUEUED');
  });
});
