# `@local-pii/adapter-job-sqlite`

SQLite prototype for the storage-neutral `JobMetadataStore` boundary.

## Responsibilities

- Persists only canonical, minimized job aggregates, value-free events, and creation-idempotency
  snapshots.
- Commits each revision change and event append in one SQLite transaction.
- Appends one value-free outbox message in that same transaction, exposes bounded pending pages,
  and acknowledges deliveries idempotently by event ID plus aggregate revision.
- Replays idempotent creation across process restarts and rejects stale compare-and-swap updates.
- Migrates the synthetic schema-v1 event history into deterministic pending schema-v2 outbox rows.
- Requires an owner-only database directory, creates a new database file with owner-only
  permissions, and rejects symlinks, non-files, or group/other-accessible database files on POSIX
  hosts.
- Uses schema versioning and rejects unknown database versions instead of guessing a migration.

## Boundary and current status

This is a development evidence adapter, not an activated durable product profile. It never stores
document bytes, filenames, paths, extracted text, detections, or review content. The default CLI and
the browser launcher continue to use no SQLite database. Production dispatch, claim leases,
retry/dead-letter policy, retention, encryption/key recovery, backup/restore, multiprocess behavior,
and migration qualification remain open before the opt-in durable profile can ship.

Filesystem evidence currently covers a trusted owner-only POSIX directory. Replacement races by an
adversarial process running as that same owner, Windows permission semantics, journal/sidecar crash
cleanup, and secure deletion are not qualified.

The adapter uses Node's built-in experimental `node:sqlite` API so the prototype does not select a
third-party database/ORM dependency. That runtime API is evidence for the port semantics, not yet a
final library decision.

## Public entry point

Import `openSqliteJobMetadataStore` from `@local-pii/adapter-job-sqlite`. Call `close()` before the
owning process releases the database.

```sh
pnpm --filter @local-pii/adapter-job-sqlite build
pnpm exec vitest run packages/adapter-job-sqlite/test
```
