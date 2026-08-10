# `@local-pii/web`

Accessible, localized React shell for the future local review workflow.

## Responsibilities

- Renders the capability and local file-metadata preflight plus the local-processing disclosure.
- Consumes the one-time in-memory launcher bootstrap without browser persistence.
- Uses shared primitives and semantic tokens from `@local-pii/ui`.
- Resolves all user-facing copy through bundled catalogs in `@local-pii/i18n`.
- Keeps expansion and RTL pseudolocales available to tests while exposing English only, alongside
  reduced-motion, forced-colors, and automated accessibility coverage.

## Current scope

The application can check a selected file's extension and size against live capabilities without
reading or uploading its bytes. It does not yet upload files, create processing jobs, or provide the
detection review workspace. Running Vite directly intentionally shows the disconnected state
because no trusted API bootstrap is present.

## Development

```sh
pnpm --filter @local-pii/web dev
pnpm --filter @local-pii/web build
pnpm exec vitest run apps/web/test packages/ui/test packages/i18n/test
```

See the [root README](../../README.md#web-foundation) for accessibility, localization, launcher,
and planned-flow context.
