# `@local-pii/api`

Loopback-only HTTP composition root for the local web application.

## Responsibilities

- Builds the Fastify server around injected application and readiness ports.
- Exposes privacy-minimized liveness, readiness, capability, and pinned-policy catalog endpoints.
- Exposes authenticated metadata-only job control plus a bounded process-local artifact and real
  asynchronous rules-scan worker with value-free detection pagination.
- Runs an authenticated 8 MiB process-local TXT/Markdown preview scan that returns aggregate counts
  or at most 100 value-free detection rows and 100 value-free conflict rows through separate
  versioned contracts.
- Enforces numeric-loopback Host validation, exact browser-origin checks, bearer authorization,
  request deadlines, cancellation, and bounded shutdown.
- Serves the built web shell and performs the development browser bootstrap on macOS and Linux.

## Current scope

This is a development scaffold. Its browser profile admits at most eight process-local artifacts
and 32 MiB of retained input bytes, accepts each byte sequence once against a declared digest, and
runs one real rules-scan worker at a time. The worker overwrites and releases its byte buffer after
processing; all artifact metadata, job metadata, and value-free results disappear at shutdown.
JavaScript strings cannot be reliably zeroized. The older preview routes remain for compatibility.
It does not yet expose durable uploads, editable review decisions, reports, downloads, or durable
storage. Detection/conflict locations never include matched values, excerpts, or evidence IDs. The
external-browser handoff also does not protect against an
adversarial local process that discovers the loopback port and wins the first-request race.

## Source layout

- `src/application.ts` is the unlistened Fastify composition root. It owns session validation,
  loopback/origin authorization, server-wide security hooks, lifecycle cancellation, and route
  assembly.
- `src/api-types.ts` defines the injected application ports and public composition options.
- `src/contract-ids.ts` is the single registry for canonical response and request schema IDs.
- `src/http-boundary.ts` owns privacy-safe error mapping, canonical validation, bounded invocation,
  and strict parameter/query/header parsing shared by routes.
- `src/routes/` groups system, artifact, preview, and job endpoints by concern.
- `src/server.ts` owns lifecycle and numeric-loopback binding; `src/main.ts` is the runnable local
  entry point.
- `src/processing.ts`, `src/job-control.ts`, and `src/preview-scan.ts` implement the current
  process-local application ports; route modules do not contain those implementations.

## Development

```sh
pnpm --filter @local-pii/api build
pnpm exec vitest run apps/api/test
pnpm start:local
```

See the [root README](../../README.md) for deployment scope, security guarantees, and limitations.
