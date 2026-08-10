# `@local-pii/adapter-job-sqlite`

SQLite prototype for the storage-neutral `JobMetadataStore` boundary.

## Responsibilities

- Persists only canonical, minimized job aggregates, value-free events, and creation-idempotency
  snapshots.
- Commits each revision change and event append in one SQLite transaction.
- Replays idempotent creation across process restarts and rejects stale compare-and-swap updates.
- Requires an owner-only database directory, creates a new database file with owner-only
  permissions, and rejects symlinks, non-files, or group/other-accessible database files on POSIX
  hosts.
- Uses schema versioning and rejects unknown database versions instead of guessing a migration.

## Boundary and current status

This is a development evidence adapter, not an activated durable product profile. It never stores
document bytes, filenames, paths, extracted text, detections, or review content. The default CLI and
the browser launcher continue to use no SQLite database. Retention, encryption/key recovery,
backup/restore, multiprocess lease/outbox behavior, and production migration qualification remain
open before the opt-in durable profile can ship.

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
