# `@local-pii/api`

Loopback-only HTTP composition root for the local web application.

## Responsibilities

- Builds the Fastify server around injected application and readiness ports.
- Exposes privacy-minimized liveness, readiness, capability, and pinned-policy catalog endpoints.
- Exposes authenticated metadata-only job creation, status, event pagination, and cancellation.
- Runs an authenticated 8 MiB process-local TXT/Markdown preview scan that returns aggregate counts
  or at most 100 value-free location/confidence/source rows through separate versioned contracts.
- Enforces numeric-loopback Host validation, exact browser-origin checks, bearer authorization,
  request deadlines, cancellation, and bounded shutdown.
- Serves the built web shell and performs the development browser bootstrap on macOS and Linux.

## Current scope

This is a development scaffold. Its preview route accepts raw bytes without a filename, scans them
in memory through the core rules application, and creates no artifact or job record. Metadata jobs
remain volatile and accept no bytes, paths, or artifact references. It does not yet expose durable
upload, asynchronous processing, editable review decisions, report, download, or durable-storage
routes. Preview locations are ephemeral Unicode code-point metadata and never include matched
values. The external-browser handoff also does not protect against an
adversarial local process that discovers the loopback port and wins the first-request race.

The unlistened server factory is in `src/application.ts`; lifecycle and binding are in
`src/server.ts`; `src/main.ts` is the runnable local entry point.

## Development

```sh
pnpm --filter @local-pii/api build
pnpm exec vitest run apps/api/test
pnpm start:local
```

See the [root README](../../README.md) for deployment scope, security guarantees, and limitations.
