# `@local-pii/api`

Loopback-only HTTP composition root for the local web application.

## Responsibilities

- Builds the Fastify server around injected application and readiness ports.
- Exposes privacy-minimized liveness, readiness, capability, and pinned-policy catalog endpoints.
- Exposes authenticated metadata-only job control plus bounded process-local artifacts and real
  asynchronous rules scan/redaction workers with value-free detection pagination.
- Stores bounded accept/reject/retype decisions as a value-free append-only process-local review
  history with extraction/job/review revision checks and idempotent client decision IDs.
- Snapshots an exact conflict-free scan and review digest into v4 redaction jobs; stale scan, policy,
  extraction, or review bindings fail closed instead of silently redacting a different decision set.
- Authorizes a verified redacted output only after the shared core reopens and verifies it, then
  serves its exact bytes under a generic attachment name.
- Runs an authenticated 8 MiB process-local TXT/Markdown preview scan that returns aggregate counts
  or at most 100 value-free detection rows and 100 value-free conflict rows through separate
  versioned contracts.
- Enforces numeric-loopback Host validation, exact browser-origin checks, bearer authorization,
  request deadlines, cancellation, and bounded shutdown.
- Serves the built web shell and performs the development browser bootstrap on macOS and Linux.

## Current scope

This is a development scaffold. Its browser profile admits at most eight process-local artifacts
and 32 MiB of retained input bytes, accepts each byte sequence once against a declared digest, and
runs one real rules scan or redaction worker at a time. Scan inputs are overwritten and released
after processing; a verified redacted output is retained only for authenticated download during the
current application launch. All artifact metadata, job metadata, value-free results, and output
bytes disappear at shutdown. JavaScript strings cannot be reliably zeroized. The older preview
routes remain for compatibility. Review history supports existing resolved detections and is
consumed by reviewed redaction: accept confirms the policy action, reject retains that exact
reviewed span, and retype applies the selected supported category. The v2 plan and verifier bind
only value-free span provenance and the review digest; boundary/manual decisions and conflict
resolution remain open. It
does not expose durable uploads, durable review persistence, reports, retained downloads, or durable
storage. Detection/conflict locations and review records never include matched
values, excerpts, or evidence IDs. The
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
