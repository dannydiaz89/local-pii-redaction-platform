# `@local-pii/sdk`

Browser-safe TypeScript client for the authenticated local PII HTTP API.

## Responsibilities

- Accepts only an exact `http://127.0.0.1:<port>` session origin and a bounded opaque bearer token.
- Sends authenticated capability, policy, artifact, job, event, detection, review, redaction,
  download, cancellation, and expiration requests without credentials, referrers, redirects, or caching.
- Enforces bounded request deadlines and response sizes before projecting canonical generated
  contract types into frozen, value-minimized application summaries.
- Requires a successful compatible capability negotiation before scan, preview, or redaction can
  upload bytes, and checks the advertised extension, size ceiling, and redaction operation.
- Keeps source filenames and detected values out of API JSON. Artifact uploads contain only the
  selected file bytes; verified downloads are checked against their advertised digest and length.
- Clears copied upload bytes after use and exposes an explicit disconnected client for browser
  development without a trusted launcher session.

## Boundary

This package contains no server, persistence, telemetry, remote-origin, or UI behavior. Its runtime
dependency is limited to `@local-pii/contracts`, used only for generated TypeScript contract types.
The current transport deliberately supports numeric loopback HTTP only; a future authenticated
remote SDK requires a separate threat model and must not weaken this local-session boundary.

The root export is the supported public surface. Internal modules are not package exports.

## Development

```sh
pnpm --filter @local-pii/sdk typecheck
pnpm exec vitest run packages/sdk/test
```
