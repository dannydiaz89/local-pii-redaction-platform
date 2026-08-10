import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  unlinkSync
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import { assertContract } from '@local-pii/contracts';
import { SafeError } from '@local-pii/domain';
import {
  prepareJobCreation,
  prepareJobTransition,
  validateJobEventQuery,
  validateJobLookup,
  type CreateJobCommand,
  type Job,
  type JobEvent,
  type JobMetadataStore,
  type JobMutationResult,
  type ListJobEventsQuery,
  type TransitionJobCommand
} from '@local-pii/job-store';

export interface SqliteJobMetadataStore extends JobMetadataStore {
  close(): void;
}

export interface OpenSqliteJobMetadataStoreOptions {
  readonly busyTimeoutMs?: number;
}

interface JobBodyRow {
  readonly revision: number;
  readonly body: string;
}

interface EventBodyRow {
  readonly id: string;
  readonly cursor: number;
  readonly body: string;
}

interface IdempotencyRow {
  readonly request_digest: string;
  readonly job_body: string;
  readonly event_body: string;
}

const jobSchemaId = 'https://local-pii.dev/schemas/jobs/job/1.0.0';
const jobEventSchemaId = 'https://local-pii.dev/schemas/jobs/job-event/1.0.0';
const schemaVersion = 1;
const applicationId = 0x4c504949;
const defaultBusyTimeoutMs = 2_000;

function fail(
  code: SafeError['code'],
  message: string,
  retryable: boolean,
  correlationId: string
): never {
  throw new SafeError({ code, message, retryable, correlationId });
}

function storageFailure(correlationId: string): never {
  fail('STORAGE_UNAVAILABLE', 'The job metadata store is unavailable.', true, correlationId);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeStoredInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function jobBodyRow(value: unknown): JobBodyRow | undefined {
  return isRecord(value) && safeStoredInteger(value.revision) && typeof value.body === 'string'
    ? { revision: value.revision, body: value.body }
    : undefined;
}

function eventBodyRow(value: unknown): EventBodyRow | undefined {
  return isRecord(value) && typeof value.id === 'string'
    && safeStoredInteger(value.cursor) && typeof value.body === 'string'
    ? { id: value.id, cursor: value.cursor, body: value.body }
    : undefined;
}

function idempotencyRow(value: unknown): IdempotencyRow | undefined {
  return isRecord(value)
    && typeof value.request_digest === 'string'
    && typeof value.job_body === 'string'
    && typeof value.event_body === 'string'
    ? {
        request_digest: value.request_digest,
        job_body: value.job_body,
        event_body: value.event_body
      }
    : undefined;
}

function decodeCanonical(body: string, schemaId: string, correlationId: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(body);
    assertContract(schemaId, value);
    if (!isRecord(value)) storageFailure(correlationId);
    return Object.freeze(value);
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    storageFailure(correlationId);
  }
}

function decodeJob(body: string, correlationId: string): Job {
  const job = decodeCanonical(body, jobSchemaId, correlationId) as unknown as Job;
  return Object.freeze({
    ...job,
    policy: Object.freeze({ ...job.policy }),
    ...(job.summary === undefined ? {} : { summary: Object.freeze({ ...job.summary }) })
  });
}

function decodeEvent(body: string, correlationId: string): JobEvent {
  const event = decodeCanonical(body, jobEventSchemaId, correlationId) as unknown as JobEvent;
  return Object.freeze({
    ...event,
    ...(event.counts === undefined ? {} : { counts: Object.freeze({ ...event.counts }) })
  });
}

function begin(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
}

function rollback(database: DatabaseSync): void {
  try { database.exec('ROLLBACK'); } catch { /* preserve the original safe failure */ }
}

function inTransaction<Result>(database: DatabaseSync, operation: () => Result): Result {
  begin(database);
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error: unknown) {
    rollback(database);
    throw error;
  }
}

function existingFileIsPrivate(databasePath: string): boolean {
  const metadata = lstatSync(databasePath, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077n) !== 0n) return false;
  const getuid = process.getuid;
  return getuid === undefined || metadata.uid === BigInt(getuid());
}

function privateDirectory(directoryPath: string): boolean {
  const metadata = lstatSync(directoryPath, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077n) !== 0n) return false;
  const getuid = process.getuid;
  return getuid === undefined || metadata.uid === BigInt(getuid());
}

function preparePrivateDatabaseFile(databasePath: string): boolean {
  if (!isAbsolute(databasePath) || databasePath.includes('\u0000')) {
    throw new TypeError('The SQLite job metadata path is invalid.');
  }
  try {
    if (!privateDirectory(dirname(databasePath))) {
      throw new TypeError('The SQLite job metadata directory is not private.');
    }
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error;
    throw new Error('The SQLite job metadata directory could not be inspected.');
  }
  let descriptor: number;
  try {
    descriptor = openSync(
      databasePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600
    );
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'EEXIST') {
      let privateFile = false;
      try { privateFile = existingFileIsPrivate(databasePath); } catch {
        throw new Error('The SQLite job metadata file could not be inspected.');
      }
      if (!privateFile) {
        throw new TypeError('The SQLite job metadata file is not private.');
      }
      return false;
    }
    throw new Error('The SQLite job metadata file could not be prepared.');
  }
  try { closeSync(descriptor); } catch {
    throw new Error('The SQLite job metadata file could not be prepared.');
  }
  return true;
}

function initializeSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
  `);
  const application = database.prepare('PRAGMA application_id').get() as Readonly<Record<string, SQLOutputValue>>;
  const version = database.prepare('PRAGMA user_version').get() as Readonly<Record<string, SQLOutputValue>>;
  const observedApplication = Number(Object.values(application)[0]);
  const observedVersion = Number(Object.values(version)[0]);
  if ((observedVersion === 0 && observedApplication !== 0)
    || (observedVersion !== 0
      && (observedApplication !== applicationId || observedVersion !== schemaVersion))) {
    throw new Error('The SQLite job metadata schema is unsupported.');
  }
  if (observedVersion === 0) {
    inTransaction(database, () => {
      database.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          body TEXT NOT NULL CHECK (json_valid(body))
        ) STRICT;
        CREATE TABLE job_events (
          id TEXT PRIMARY KEY NOT NULL,
          job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          cursor INTEGER NOT NULL CHECK (cursor >= 1),
          body TEXT NOT NULL CHECK (json_valid(body)),
          UNIQUE (job_id, cursor)
        ) STRICT;
        CREATE TABLE job_idempotency (
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          job_body TEXT NOT NULL CHECK (json_valid(job_body)),
          event_body TEXT NOT NULL CHECK (json_valid(event_body)),
          PRIMARY KEY (scope, key)
        ) STRICT;
        CREATE INDEX job_events_page ON job_events(job_id, cursor);
        PRAGMA application_id = ${String(applicationId)};
        PRAGMA user_version = ${String(schemaVersion)};
      `);
    });
  }
  const quickCheck = database.prepare('PRAGMA quick_check').get() as Readonly<Record<string, SQLOutputValue>>;
  if (Object.values(quickCheck)[0] !== 'ok') {
    throw new Error('The SQLite job metadata store failed its integrity check.');
  }
  for (const query of [
    'SELECT id, revision, body FROM jobs LIMIT 0',
    'SELECT id, job_id, cursor, body FROM job_events LIMIT 0',
    'SELECT scope, key, request_digest, job_body, event_body FROM job_idempotency LIMIT 0'
  ]) database.prepare(query).all();
}

function findJob(database: DatabaseSync, jobId: string, correlationId: string): Job | undefined {
  const value = database.prepare('SELECT revision, body FROM jobs WHERE id = ?').get(jobId);
  if (value === undefined) return undefined;
  const row = jobBodyRow(value);
  if (row === undefined) storageFailure(correlationId);
  const job = decodeJob(row.body, correlationId);
  if (job.id !== jobId || job.revision !== row.revision) storageFailure(correlationId);
  return job;
}

function eventIdentifierExists(database: DatabaseSync, eventId: string): boolean {
  return database.prepare('SELECT 1 AS found FROM job_events WHERE id = ?').get(eventId) !== undefined;
}

/**
 * Opens the SQLite metadata prototype. `:memory:` is accepted for conformance tests; filesystem
 * paths must be absolute and private. Construction errors never include the supplied path.
 */
export function openSqliteJobMetadataStore(
  databasePath: string,
  options: OpenSqliteJobMetadataStoreOptions = {}
): SqliteJobMetadataStore {
  const busyTimeoutMs = options.busyTimeoutMs ?? defaultBusyTimeoutMs;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 30_000) {
    throw new TypeError('The SQLite busy timeout is invalid.');
  }
  const memory = databasePath === ':memory:';
  const created = memory ? false : preparePrivateDatabaseFile(databasePath);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: busyTimeoutMs
    });
    initializeSchema(database);
  } catch {
    try { database?.close(); } catch { /* preserve the privacy-safe construction failure */ }
    if (created) {
      try { unlinkSync(databasePath); } catch { /* application created it, but cleanup is best effort */ }
    }
    throw new Error('The SQLite job metadata store could not be opened.');
  }
  const openedDatabase = database;

  let closed = false;
  const available = (correlationId: string): void => {
    if (closed) storageFailure(correlationId);
  };

  const store: SqliteJobMetadataStore = {
    async create(command: CreateJobCommand, signal?: AbortSignal): Promise<JobMutationResult> {
      signal?.throwIfAborted();
      const prepared = prepareJobCreation(command);
      await Promise.resolve();
      signal?.throwIfAborted();
      available(command.correlationId);
      try {
        return inTransaction(openedDatabase, () => {
          signal?.throwIfAborted();
          const prior = idempotencyRow(openedDatabase.prepare(`
            SELECT request_digest, job_body, event_body
            FROM job_idempotency WHERE scope = ? AND key = ?
          `).get(prepared.idempotency.scope, prepared.idempotency.key));
          if (prior !== undefined) {
            if (prior.request_digest !== prepared.idempotency.requestDigest) {
              fail(
                'IDEMPOTENCY_CONFLICT',
                'The request key was already used for different job metadata.',
                false,
                command.correlationId
              );
            }
            const job = decodeJob(prior.job_body, command.correlationId);
            const event = decodeEvent(prior.event_body, command.correlationId);
            if (job.revision !== 1 || event.jobId !== job.id || event.revision !== 1 || event.cursor !== 1) {
              storageFailure(command.correlationId);
            }
            return Object.freeze({
              job,
              event,
              replayed: true
            });
          }
          if (findJob(openedDatabase, prepared.job.id, command.correlationId) !== undefined
            || eventIdentifierExists(openedDatabase, prepared.event.id)) {
            fail('JOB_CONFLICT', 'The job or event already exists.', false, command.correlationId);
          }
          const jobBody = JSON.stringify(prepared.job);
          const eventBody = JSON.stringify(prepared.event);
          openedDatabase.prepare('INSERT INTO jobs (id, revision, body) VALUES (?, ?, ?)')
            .run(prepared.job.id, prepared.job.revision, jobBody);
          openedDatabase.prepare('INSERT INTO job_events (id, job_id, cursor, body) VALUES (?, ?, ?, ?)')
            .run(prepared.event.id, prepared.job.id, prepared.event.cursor, eventBody);
          openedDatabase.prepare(`
            INSERT INTO job_idempotency (scope, key, request_digest, job_body, event_body)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            prepared.idempotency.scope,
            prepared.idempotency.key,
            prepared.idempotency.requestDigest,
            jobBody,
            eventBody
          );
          return Object.freeze({ job: prepared.job, event: prepared.event, replayed: false });
        });
      } catch (error: unknown) {
        if (error instanceof SafeError || error instanceof DOMException) throw error;
        storageFailure(command.correlationId);
      }
    },

    async transition(command: TransitionJobCommand, signal?: AbortSignal): Promise<JobMutationResult> {
      signal?.throwIfAborted();
      const jobId = validateJobLookup(command.jobId, command.correlationId);
      await Promise.resolve();
      signal?.throwIfAborted();
      available(command.correlationId);
      try {
        return inTransaction(openedDatabase, () => {
          signal?.throwIfAborted();
          const current = findJob(openedDatabase, jobId, command.correlationId);
          if (current === undefined) {
            fail('JOB_CONFLICT', 'The job does not exist.', false, command.correlationId);
          }
          const prepared = prepareJobTransition(current, command);
          if (eventIdentifierExists(openedDatabase, prepared.event.id)) {
            fail('JOB_CONFLICT', 'The job event already exists.', false, command.correlationId);
          }
          const update = openedDatabase.prepare(`
            UPDATE jobs SET revision = ?, body = ? WHERE id = ? AND revision = ?
          `).run(
            prepared.job.revision,
            JSON.stringify(prepared.job),
            jobId,
            command.expectedRevision
          );
          if (Number(update.changes) !== 1) {
            fail('JOB_CONFLICT', 'The job revision changed.', true, command.correlationId);
          }
          openedDatabase.prepare('INSERT INTO job_events (id, job_id, cursor, body) VALUES (?, ?, ?, ?)')
            .run(
              prepared.event.id,
              jobId,
              prepared.event.cursor,
              JSON.stringify(prepared.event)
            );
          return Object.freeze({ job: prepared.job, event: prepared.event, replayed: false });
        });
      } catch (error: unknown) {
        if (error instanceof SafeError || error instanceof DOMException) throw error;
        storageFailure(command.correlationId);
      }
    },

    async get(jobIdInput: string, correlationId: string, signal?: AbortSignal): Promise<Job | undefined> {
      signal?.throwIfAborted();
      const jobId = validateJobLookup(jobIdInput, correlationId);
      await Promise.resolve();
      signal?.throwIfAborted();
      available(correlationId);
      try {
        return findJob(openedDatabase, jobId, correlationId);
      } catch (error: unknown) {
        if (error instanceof SafeError || error instanceof DOMException) throw error;
        storageFailure(correlationId);
      }
    },

    async listEvents(query: ListJobEventsQuery, signal?: AbortSignal): Promise<readonly JobEvent[]> {
      signal?.throwIfAborted();
      const validated = validateJobEventQuery(query);
      await Promise.resolve();
      signal?.throwIfAborted();
      available(query.correlationId);
      try {
        const rows = openedDatabase.prepare(`
          SELECT id, cursor, body FROM job_events
          WHERE job_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?
        `).all(validated.jobId, validated.afterCursor, validated.limit);
        return Object.freeze(rows.map((row) => {
          const body = eventBodyRow(row);
          if (body === undefined) storageFailure(query.correlationId);
          const event = decodeEvent(body.body, query.correlationId);
          if (event.id !== body.id
            || event.jobId !== validated.jobId
            || event.cursor !== body.cursor
            || event.revision !== event.cursor) {
            storageFailure(query.correlationId);
          }
          return event;
        }));
      } catch (error: unknown) {
        if (error instanceof SafeError || error instanceof DOMException) throw error;
        storageFailure(query.correlationId);
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      openedDatabase.close();
    }
  };
  return Object.freeze(store);
}
