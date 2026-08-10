# `@local-pii/api`

Loopback-only HTTP composition root for the local web application.

## Responsibilities

- Builds the Fastify server around injected application and readiness ports.
- Exposes privacy-minimized liveness, readiness, capability, and pinned-policy catalog endpoints.
- Exposes authenticated metadata-only job creation, status, event pagination, and cancellation.
- Enforces numeric-loopback Host validation, exact browser-origin checks, bearer authorization,
  request deadlines, cancellation, and bounded shutdown.
- Serves the built web shell and performs the development browser bootstrap on macOS and Linux.

## Current scope

This is a development scaffold. Its jobs use a volatile process-local metadata adapter and do not
accept document bytes, filenames, paths, or artifact references. It does not yet expose upload,
processing, review, report, download, or durable-storage routes. The external-browser handoff also does not protect against an
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
