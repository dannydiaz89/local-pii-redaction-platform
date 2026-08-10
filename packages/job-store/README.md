# `@local-pii/job-store`

Storage-neutral job metadata boundary for the future opt-in durable application profile.

## Responsibilities

- Defines the port used to create, read, and transition minimized job aggregates.
- Enforces optimistic revision checks and the canonical job-state transition graph.
- Makes idempotent creation replay-safe and rejects key reuse with a different request digest.
- Couples each accepted mutation to a value-free canonical job event.
- Provides a deliberately volatile reference adapter for conformance and application-development
  tests.

## Boundary

This package never stores document bytes, extracted text, filenames, paths, detections, or review
content. It does not select a database or enable persistence in the CLI or API. Shared preparation
helpers let adapters apply these exact validation and mutation rules without duplicating them. The
local API
development scaffold now composes the exported `createVolatileJobMetadataStore` for metadata-only
job control; it loses all state on process exit and must not be described as a durable
implementation or processing queue.

The separate `@local-pii/adapter-job-sqlite` package now prototypes transaction and restart behavior
against this port. It remains disabled in the application while encryption, retention, migration,
backup, leases, and outbox behavior are unqualified.

## Public entry point

Import the store port, commands, results, and volatile reference adapter from
`@local-pii/job-store`.

```sh
pnpm --filter @local-pii/job-store build
pnpm exec vitest run packages/job-store/test
```
