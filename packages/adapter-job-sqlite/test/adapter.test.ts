import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { SafeError } from '@local-pii/domain';
import type { CreateJobCommand } from '@local-pii/job-store';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteJobMetadataStore, type SqliteJobMetadataStore } from '../src/index.js';

const jobId = 'job_01J4M91NJK8WAPJ7J95K73CB2M';
const secondJobId = 'job_01J4M91NJK8WAPJ7J95K73CB2N';
const correlationId = 'cor_synthetic_sqlite_store';
const firstEventId = '603df129-c778-4b13-8b2a-0fe745593c8f';
const secondEventId = '703df129-c778-4b13-8b2a-0fe745593c8f';
const thirdEventId = '803df129-c778-4b13-8b2a-0fe745593c8f';
const firstConsumerId = '903df129-c778-4b13-8b2a-0fe745593c8f';
const secondConsumerId = 'a03df129-c778-4b13-8b2a-0fe745593c8f';
const thirdConsumerId = 'b03df129-c778-4b13-8b2a-0fe745593c8f';
const requestDigest = `sha256:${'a'.repeat(64)}`;
const temporaryRoots: string[] = [];

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

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'local-pii-sqlite-job-test-'));
  temporaryRoots.push(root);
  return join(root, 'jobs.sqlite3');
}

async function expectSafeError(
  operation: Promise<unknown>,
  code: SafeError['code'],
  retryable: boolean
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code, retryable, correlationId });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SQLite job metadata adapter', () => {
  it('creates a private database and atomically stores a canonical job and event', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    try {
      const result = await store.create(createCommand());
      expect(result).toMatchObject({
        replayed: false,
        job: { id: jobId, state: 'QUEUED', revision: 1 },
        event: { id: firstEventId, jobId, cursor: 1, revision: 1, type: 'JOB_CREATED' }
      });
      expect(await store.get(jobId, correlationId)).toEqual(result.job);
      expect(await store.listEvents({ jobId, correlationId })).toEqual([result.event]);
      expect(await store.listPendingOutbox({ correlationId })).toEqual([{
        schemaVersion: '1.0.0',
        cursor: 1,
        eventId: firstEventId,
        jobId,
        revision: 1,
        eventCursor: 1,
        eventType: 'JOB_CREATED',
        occurredAt: '2026-08-09T18:00:00Z',
        deduplicationKey: `${firstEventId}:1`
      }]);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });

  it('persists ordered outbox messages and idempotent acknowledgements across restart', async () => {
    const path = await databasePath();
    const first = openSqliteJobMetadataStore(path);
    await first.create(createCommand());
    await first.transition({
      jobId,
      expectedRevision: 1,
      to: 'VALIDATING',
      now: '2026-08-09T18:01:00Z',
      eventId: secondEventId,
      correlationId
    });
    const messages = await first.listPendingOutbox({ correlationId, limit: 2 });
    expect(messages.map(({ cursor, eventId, revision, deduplicationKey }) => ({
      cursor, eventId, revision, deduplicationKey
    }))).toEqual([
      { cursor: 1, eventId: firstEventId, revision: 1, deduplicationKey: `${firstEventId}:1` },
      { cursor: 2, eventId: secondEventId, revision: 2, deduplicationKey: `${secondEventId}:2` }
    ]);
    const acknowledged = await first.acknowledgeOutbox({
      eventId: firstEventId,
      revision: 1,
      acknowledgedAt: '2026-08-09T18:02:00Z',
      correlationId
    });
    expect(acknowledged).toMatchObject({ replayed: false, acknowledgedAt: '2026-08-09T18:02:00Z' });
    expect((await first.listPendingOutbox({ correlationId })).map(({ eventId }) => eventId))
      .toEqual([secondEventId]);
    first.close();

    const restarted = openSqliteJobMetadataStore(path);
    try {
      expect((await restarted.listPendingOutbox({ correlationId })).map(({ eventId }) => eventId))
        .toEqual([secondEventId]);
      expect(await restarted.acknowledgeOutbox({
        eventId: firstEventId,
        revision: 1,
        acknowledgedAt: '2026-08-09T19:00:00Z',
        correlationId
      })).toMatchObject({
        replayed: true,
        acknowledgedAt: '2026-08-09T18:02:00Z',
        message: { deduplicationKey: `${firstEventId}:1` }
      });
    } finally {
      restarted.close();
    }
  });

  it('migrates schema v1 events into a deterministic pending outbox', async () => {
    const path = await databasePath();
    const original = openSqliteJobMetadataStore(path);
    await original.create(createCommand());
    original.close();

    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TABLE job_outbox; PRAGMA user_version = 1;');
    legacy.close();

    const migrated = openSqliteJobMetadataStore(path);
    try {
      expect(await migrated.listPendingOutbox({ correlationId })).toMatchObject([{
        cursor: 1,
        eventId: firstEventId,
        revision: 1,
        eventCursor: 1
      }]);
      const raw = new DatabaseSync(path);
      const version = raw.prepare('PRAGMA user_version').get() as Record<string, unknown>;
      raw.close();
      expect(Number(Object.values(version)[0])).toBe(3);
    } finally {
      migrated.close();
    }
  });

  it('migrates schema v2 acknowledgements without making them pending again', async () => {
    const path = await databasePath();
    const original = openSqliteJobMetadataStore(path);
    await original.create(createCommand());
    await original.acknowledgeOutbox({
      eventId: firstEventId,
      revision: 1,
      acknowledgedAt: '2026-08-09T18:02:00Z',
      correlationId
    });
    original.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP INDEX job_outbox_pending;
      ALTER TABLE job_outbox RENAME TO job_outbox_v3;
      CREATE TABLE job_outbox (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT CHECK (cursor >= 1),
        event_id TEXT NOT NULL UNIQUE REFERENCES job_events(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        event_cursor INTEGER NOT NULL CHECK (event_cursor >= 1),
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        acknowledged_at TEXT,
        UNIQUE (job_id, revision),
        CHECK (revision = event_cursor)
      ) STRICT;
      INSERT INTO job_outbox (
        cursor, event_id, job_id, revision, event_cursor, event_type, occurred_at, acknowledged_at
      )
      SELECT cursor, event_id, job_id, revision, event_cursor, event_type, occurred_at, acknowledged_at
      FROM job_outbox_v3;
      DROP TABLE job_outbox_v3;
      CREATE INDEX job_outbox_pending ON job_outbox(acknowledged_at, cursor);
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const migrated = openSqliteJobMetadataStore(path);
    try {
      expect(await migrated.listPendingOutbox({ correlationId })).toEqual([]);
      expect(await migrated.acknowledgeOutbox({
        eventId: firstEventId,
        revision: 1,
        acknowledgedAt: '2026-08-09T19:00:00Z',
        correlationId
      })).toMatchObject({ replayed: true, acknowledgedAt: '2026-08-09T18:02:00Z' });
    } finally {
      migrated.close();
    }
  });

  it('claims deliveries exclusively and completes the owning attempt idempotently across restart', async () => {
    const path = await databasePath();
    const first = openSqliteJobMetadataStore(path);
    const second = openSqliteJobMetadataStore(path);
    try {
      await first.create(createCommand());
      const [claim] = await first.claimPendingOutbox({
        consumerId: firstConsumerId,
        now: '2026-08-09T18:01:00Z',
        leaseExpiresAt: '2026-08-09T18:02:00Z',
        correlationId
      });
      expect(claim).toMatchObject({
        consumerId: firstConsumerId,
        attempt: 1,
        message: { eventId: firstEventId, revision: 1 }
      });
      expect(await second.claimPendingOutbox({
        consumerId: secondConsumerId,
        now: '2026-08-09T18:01:30Z',
        leaseExpiresAt: '2026-08-09T18:02:30Z',
        correlationId
      })).toEqual([]);
      await expectSafeError(second.acknowledgeOutbox({
        eventId: firstEventId,
        revision: 1,
        acknowledgedAt: '2026-08-09T18:01:45Z',
        correlationId
      }), 'JOB_CONFLICT', true);
      await expectSafeError(second.completeOutboxClaim({
        eventId: firstEventId,
        revision: 1,
        consumerId: secondConsumerId,
        attempt: 1,
        acknowledgedAt: '2026-08-09T18:01:45Z',
        correlationId
      }), 'JOB_CONFLICT', true);
      expect(await first.completeOutboxClaim({
        eventId: firstEventId,
        revision: 1,
        consumerId: firstConsumerId,
        attempt: 1,
        acknowledgedAt: '2026-08-09T18:01:45Z',
        correlationId
      })).toMatchObject({ replayed: false });
    } finally {
      first.close();
      second.close();
    }

    const restarted = openSqliteJobMetadataStore(path);
    try {
      expect(await restarted.completeOutboxClaim({
        eventId: firstEventId,
        revision: 1,
        consumerId: firstConsumerId,
        attempt: 1,
        acknowledgedAt: '2026-08-09T18:02:00Z',
        correlationId
      })).toMatchObject({
        replayed: true,
        acknowledgedAt: '2026-08-09T18:01:45Z'
      });
    } finally {
      restarted.close();
    }
  });

  it('schedules bounded retries and recovers an expired lease with a new attempt', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    try {
      await store.create(createCommand());
      const [firstClaim] = await store.claimPendingOutbox({
        consumerId: firstConsumerId,
        now: '2026-08-09T18:01:00Z',
        leaseExpiresAt: '2026-08-09T18:02:00Z',
        correlationId
      });
      expect(firstClaim?.attempt).toBe(1);
      expect(await store.failOutboxClaim({
        eventId: firstEventId,
        revision: 1,
        consumerId: firstConsumerId,
        attempt: 1,
        failedAt: '2026-08-09T18:01:30Z',
        retryAt: '2026-08-09T18:05:00Z',
        correlationId
      })).toMatchObject({ disposition: 'RETRY_SCHEDULED', attempt: 1 });
      expect(await store.claimPendingOutbox({
        consumerId: secondConsumerId,
        now: '2026-08-09T18:04:59Z',
        leaseExpiresAt: '2026-08-09T18:05:59Z',
        correlationId
      })).toEqual([]);
      const [secondClaim] = await store.claimPendingOutbox({
        consumerId: secondConsumerId,
        now: '2026-08-09T18:05:00Z',
        leaseExpiresAt: '2026-08-09T18:06:00Z',
        correlationId
      });
      expect(secondClaim?.attempt).toBe(2);
      const [recovered] = await store.claimPendingOutbox({
        consumerId: thirdConsumerId,
        now: '2026-08-09T18:06:01Z',
        leaseExpiresAt: '2026-08-09T18:07:01Z',
        correlationId
      });
      expect(recovered).toMatchObject({ consumerId: thirdConsumerId, attempt: 3 });
      await expectSafeError(store.completeOutboxClaim({
        eventId: firstEventId,
        revision: 1,
        consumerId: secondConsumerId,
        attempt: 2,
        acknowledgedAt: '2026-08-09T18:05:30Z',
        correlationId
      }), 'JOB_CONFLICT', true);
    } finally {
      store.close();
    }
  });

  it('persists active leases and retry availability across process restarts', async () => {
    const path = await databasePath();
    const first = openSqliteJobMetadataStore(path);
    await first.create(createCommand());
    await first.claimPendingOutbox({
      consumerId: firstConsumerId,
      now: '2026-08-09T18:01:00Z',
      leaseExpiresAt: '2026-08-09T18:02:00Z',
      correlationId
    });
    first.close();

    const second = openSqliteJobMetadataStore(path);
    try {
      expect(await second.claimPendingOutbox({
        consumerId: secondConsumerId,
        now: '2026-08-09T18:01:59Z',
        leaseExpiresAt: '2026-08-09T18:02:59Z',
        correlationId
      })).toEqual([]);
      const [recovered] = await second.claimPendingOutbox({
        consumerId: secondConsumerId,
        now: '2026-08-09T18:02:00Z',
        leaseExpiresAt: '2026-08-09T18:03:00Z',
        correlationId
      });
      expect(recovered?.attempt).toBe(2);
      await second.failOutboxClaim({
        eventId: firstEventId,
        revision: 1,
        consumerId: secondConsumerId,
        attempt: 2,
        failedAt: '2026-08-09T18:02:30Z',
        retryAt: '2026-08-09T18:05:00Z',
        correlationId
      });
    } finally {
      second.close();
    }

    const third = openSqliteJobMetadataStore(path);
    try {
      expect(await third.claimPendingOutbox({
        consumerId: thirdConsumerId,
        now: '2026-08-09T18:04:59Z',
        leaseExpiresAt: '2026-08-09T18:05:59Z',
        correlationId
      })).toEqual([]);
      expect(await third.claimPendingOutbox({
        consumerId: thirdConsumerId,
        now: '2026-08-09T18:05:00Z',
        leaseExpiresAt: '2026-08-09T18:06:00Z',
        correlationId
      })).toMatchObject([{ consumerId: thirdConsumerId, attempt: 3 }]);
    } finally {
      third.close();
    }
  });

  it('dead-letters a delivery after the fifth failed attempt and never reclaims it', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    try {
      await store.create(createCommand());
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const minute = attempt * 2;
        const now = `2026-08-09T18:${String(minute).padStart(2, '0')}:00Z`;
        const expiresAt = `2026-08-09T18:${String(minute + 1).padStart(2, '0')}:00Z`;
        const [claim] = await store.claimPendingOutbox({
          consumerId: firstConsumerId, now, leaseExpiresAt: expiresAt, correlationId
        });
        expect(claim?.attempt).toBe(attempt);
        const failedAt = `2026-08-09T18:${String(minute).padStart(2, '0')}:30Z`;
        const retryAt = `2026-08-09T18:${String(minute + 2).padStart(2, '0')}:00Z`;
        const result = await store.failOutboxClaim({
          eventId: firstEventId,
          revision: 1,
          consumerId: firstConsumerId,
          attempt,
          failedAt,
          retryAt,
          correlationId
        });
        expect(result.disposition).toBe(attempt === 5 ? 'DEAD_LETTERED' : 'RETRY_SCHEDULED');
      }
      expect(await store.listPendingOutbox({ correlationId })).toEqual([]);
      expect(await store.claimPendingOutbox({
        consumerId: secondConsumerId,
        now: '2026-08-09T18:20:00Z',
        leaseExpiresAt: '2026-08-09T18:21:00Z',
        correlationId
      })).toEqual([]);
      expect(await store.listDeadLetterOutbox({ correlationId })).toMatchObject([{
        attempts: 5,
        deadLetteredAt: '2026-08-09T18:10:30Z',
        message: { eventId: firstEventId, revision: 1 }
      }]);
    } finally {
      store.close();
    }
  });

  it('dead-letters an exhausted lease after a consumer disappears', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    try {
      await store.create(createCommand());
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const minute = attempt * 2;
        const [claim] = await store.claimPendingOutbox({
          consumerId: firstConsumerId,
          now: `2026-08-09T18:${String(minute).padStart(2, '0')}:00Z`,
          leaseExpiresAt: `2026-08-09T18:${String(minute + 1).padStart(2, '0')}:00Z`,
          correlationId
        });
        expect(claim?.attempt).toBe(attempt);
        if (attempt < 5) {
          await store.failOutboxClaim({
            eventId: firstEventId,
            revision: 1,
            consumerId: firstConsumerId,
            attempt,
            failedAt: `2026-08-09T18:${String(minute).padStart(2, '0')}:30Z`,
            retryAt: `2026-08-09T18:${String(minute + 2).padStart(2, '0')}:00Z`,
            correlationId
          });
        }
      }
      expect(await store.claimPendingOutbox({
        consumerId: secondConsumerId,
        now: '2026-08-09T18:11:01Z',
        leaseExpiresAt: '2026-08-09T18:12:01Z',
        correlationId
      })).toEqual([]);
      expect(await store.listDeadLetterOutbox({ correlationId })).toMatchObject([{
        attempts: 5,
        deadLetteredAt: '2026-08-09T18:11:01Z'
      }]);
    } finally {
      store.close();
    }
  });

  it('survives restart and replays the original creation snapshot after later revisions', async () => {
    const path = await databasePath();
    const first = openSqliteJobMetadataStore(path);
    await first.create(createCommand());
    await first.transition({
      jobId,
      expectedRevision: 1,
      to: 'VALIDATING',
      now: '2026-08-09T18:01:00Z',
      eventId: secondEventId,
      correlationId
    });
    first.close();

    const restarted = openSqliteJobMetadataStore(path);
    try {
      expect(await restarted.get(jobId, correlationId)).toMatchObject({ state: 'VALIDATING', revision: 2 });
      expect(await restarted.listEvents({ jobId, correlationId })).toHaveLength(2);
      const replay = await restarted.create(createCommand({ jobId: secondJobId, eventId: thirdEventId }));
      expect(replay).toMatchObject({
        replayed: true,
        job: { id: jobId, state: 'QUEUED', revision: 1 },
        event: { id: firstEventId, revision: 1 }
      });
      expect((await restarted.get(jobId, correlationId))?.revision).toBe(2);
    } finally {
      restarted.close();
    }
  });

  it('rejects conflicting idempotency reuse without creating a second aggregate', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    try {
      await store.create(createCommand());
      await expectSafeError(store.create(createCommand({
        jobId: secondJobId,
        eventId: secondEventId,
        idempotency: {
          scope: 'local-session',
          key: 'request-1',
          requestDigest: `sha256:${'c'.repeat(64)}`
        }
      })), 'IDEMPOTENCY_CONFLICT', false);
      expect(await store.get(secondJobId, correlationId)).toBeUndefined();
      expect(await store.listEvents({ jobId, correlationId })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('commits each compare-and-swap revision with exactly one event across connections', async () => {
    const path = await databasePath();
    const first = openSqliteJobMetadataStore(path);
    const second = openSqliteJobMetadataStore(path);
    try {
      await first.create(createCommand());
      await first.transition({
        jobId,
        expectedRevision: 1,
        to: 'VALIDATING',
        now: '2026-08-09T18:01:00Z',
        eventId: secondEventId,
        correlationId
      });
      await expectSafeError(second.transition({
        jobId,
        expectedRevision: 1,
        to: 'CANCELLING',
        now: '2026-08-09T18:01:00Z',
        eventId: thirdEventId,
        correlationId
      }), 'JOB_CONFLICT', true);
      expect(await second.get(jobId, correlationId)).toMatchObject({ state: 'VALIDATING', revision: 2 });
      expect(await second.listEvents({ jobId, correlationId })).toHaveLength(2);
    } finally {
      first.close();
      second.close();
    }
  });

  it('rejects duplicate event identifiers without advancing the job', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    try {
      await store.create(createCommand());
      await expectSafeError(store.transition({
        jobId,
        expectedRevision: 1,
        to: 'VALIDATING',
        now: '2026-08-09T18:01:00Z',
        eventId: firstEventId,
        correlationId
      }), 'JOB_CONFLICT', false);
      expect(await store.get(jobId, correlationId)).toMatchObject({ state: 'QUEUED', revision: 1 });
      expect(await store.listEvents({ jobId, correlationId })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('rolls back the aggregate update when a later event insert fails', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    try {
      await store.create(createCommand());
      const faultConnection = new DatabaseSync(path);
      faultConnection.exec(`
        CREATE TRIGGER synthetic_event_insert_failure
        BEFORE INSERT ON job_events
        WHEN NEW.cursor = 2
        BEGIN
          SELECT RAISE(ABORT, 'synthetic event insert failure');
        END;
      `);
      faultConnection.close();

      await expectSafeError(store.transition({
        jobId,
        expectedRevision: 1,
        to: 'VALIDATING',
        now: '2026-08-09T18:01:00Z',
        eventId: secondEventId,
        correlationId
      }), 'STORAGE_UNAVAILABLE', true);
      expect(await store.get(jobId, correlationId)).toMatchObject({ state: 'QUEUED', revision: 1 });
      expect(await store.listEvents({ jobId, correlationId })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('rolls back the aggregate and event when the atomic outbox append fails', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    try {
      await store.create(createCommand());
      const faultConnection = new DatabaseSync(path);
      faultConnection.exec(`
        CREATE TRIGGER synthetic_outbox_insert_failure
        BEFORE INSERT ON job_outbox
        WHEN NEW.revision = 2
        BEGIN
          SELECT RAISE(ABORT, 'synthetic outbox insert failure');
        END;
      `);
      faultConnection.close();

      await expectSafeError(store.transition({
        jobId,
        expectedRevision: 1,
        to: 'VALIDATING',
        now: '2026-08-09T18:01:00Z',
        eventId: secondEventId,
        correlationId
      }), 'STORAGE_UNAVAILABLE', true);
      expect(await store.get(jobId, correlationId)).toMatchObject({ state: 'QUEUED', revision: 1 });
      expect(await store.listEvents({ jobId, correlationId })).toHaveLength(1);
      expect(await store.listPendingOutbox({ correlationId })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('rejects mismatched acknowledgement revisions without consuming the outbox message', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    try {
      await store.create(createCommand());
      await expectSafeError(store.acknowledgeOutbox({
        eventId: firstEventId,
        revision: 2,
        acknowledgedAt: '2026-08-09T18:02:00Z',
        correlationId
      }), 'JOB_CONFLICT', false);
      expect(await store.listPendingOutbox({ correlationId })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('does not mutate storage when cancellation is already requested', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(store.create(createCommand(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(await store.get(jobId, correlationId)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('stores only the minimized metadata shape and no planted source-shaped canaries', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    await store.create(createCommand());
    store.close();

    const bytes = await readFile(path);
    const encoded = bytes.toString('utf8');
    for (const prohibited of [
      'synthetic-source-canary', 'filename', 'displayName', 'locator', 'excerpt', 'documentText'
    ]) {
      expect(encoded).not.toContain(prohibited);
    }
  });

  it('fails closed when stored revision metadata disagrees with its canonical body', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    await store.create(createCommand());
    store.close();

    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE jobs SET revision = 2 WHERE id = ?').run(jobId);
    raw.close();
    const reopened = openSqliteJobMetadataStore(path);
    try {
      await expectSafeError(reopened.get(jobId, correlationId), 'STORAGE_UNAVAILABLE', true);
    } finally {
      reopened.close();
    }
  });

  it.each([
    ['row identifier', { id: secondEventId }],
    ['cursor revision', { revision: 2 }]
  ])('fails closed when a stored event body disagrees with its %s', async (_label, mutation) => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    const created = await store.create(createCommand());
    store.close();

    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE job_events SET body = ? WHERE id = ?')
      .run(JSON.stringify({ ...created.event, ...mutation }), firstEventId);
    raw.close();
    const reopened = openSqliteJobMetadataStore(path);
    try {
      await expectSafeError(
        reopened.listEvents({ jobId, correlationId }),
        'STORAGE_UNAVAILABLE',
        true
      );
    } finally {
      reopened.close();
    }
  });

  it('fails closed when stored outbox metadata disagrees with its canonical event', async () => {
    const path = await databasePath();
    const store = openSqliteJobMetadataStore(path);
    await store.create(createCommand());
    store.close();

    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE job_outbox SET event_type = ? WHERE event_id = ?')
      .run('PLANTED_PRIVATE_VALUE', firstEventId);
    raw.close();
    const reopened = openSqliteJobMetadataStore(path);
    try {
      await expectSafeError(
        reopened.listPendingOutbox({ correlationId }),
        'STORAGE_UNAVAILABLE',
        true
      );
    } finally {
      reopened.close();
    }
  });

  it('rejects group-readable files, symlinks, and unknown schema versions without leaking paths', async () => {
    const publicRoot = await mkdtemp(join(tmpdir(), 'local-pii-sqlite-public-test-'));
    temporaryRoots.push(publicRoot);
    await chmod(publicRoot, 0o755);
    expect(() => openSqliteJobMetadataStore(join(publicRoot, 'jobs.sqlite3')))
      .toThrow('The SQLite job metadata directory is not private.');

    const exposed = await databasePath();
    await writeFile(exposed, new Uint8Array());
    await chmod(exposed, 0o640);
    expect(() => openSqliteJobMetadataStore(exposed)).toThrow('The SQLite job metadata file is not private.');

    const target = await databasePath();
    await writeFile(target, new Uint8Array());
    await chmod(target, 0o600);
    const link = await databasePath();
    await symlink(target, link);
    expect(() => openSqliteJobMetadataStore(link)).toThrow('The SQLite job metadata file is not private.');

    const unsupported = await databasePath();
    const raw = new DatabaseSync(unsupported);
    raw.exec('PRAGMA application_id = 1280330057; PRAGMA user_version = 99;');
    raw.close();
    await chmod(unsupported, 0o600);
    let message = '';
    try { openSqliteJobMetadataStore(unsupported); } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('The SQLite job metadata store could not be opened.');
    expect(message).not.toContain(unsupported);
  });

  it('fails closed with a canonical storage error after close', async () => {
    const path = await databasePath();
    const store: SqliteJobMetadataStore = openSqliteJobMetadataStore(path);
    store.close();
    store.close();
    await expectSafeError(store.get(jobId, correlationId), 'STORAGE_UNAVAILABLE', true);
  });
});
