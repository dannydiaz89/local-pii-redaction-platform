# `@local-pii/web`

Accessible, localized React shell for the future local review workflow.

## Responsibilities

- Renders the capability, pinned-policy, and local file-metadata preflight plus the local-processing disclosure.
- Provides a bounded typed client for metadata-only job create/status/events/cancellation requests.
- Runs an authenticated ephemeral rules-only preview scan and renders localized aggregate counts,
  a bounded filterable native detection table, and a bounded native value-free conflict table.
- Keeps wide result tables keyboard-scrollable on narrow viewports.
- Consumes the one-time in-memory launcher bootstrap without browser persistence.
- Uses shared primitives and semantic tokens from `@local-pii/ui`.
- Resolves all user-facing copy through bundled catalogs in `@local-pii/i18n`.
- Keeps expansion and RTL pseudolocales available to tests while exposing English only, alongside
  reduced-motion, forced-colors, and automated accessibility coverage.

## Current scope

The application accepts a TXT or Markdown file up to 8 MiB, sends only its raw bytes to the
same-origin numeric-loopback API, and renders privacy-minimized category counts. The filename is not
sent and neither bytes nor results enter browser persistence, an artifact repository, or a job
store. Up to 100 detection rows expose only category, one-based Unicode code-point location,
detector confidence, and evidence-source labels. Up to 100 conflict rows expose only range,
possible categories, and source labels; matched values and evidence IDs are not returned or
rendered. The durable
job client is not yet connected to a UI action, and the application does not provide editable
review decisions, redaction, or download. Running Vite directly intentionally shows the disconnected state
because no trusted API bootstrap is present.

## Development

```sh
pnpm --filter @local-pii/web dev
pnpm --filter @local-pii/web build
pnpm exec vitest run apps/web/test packages/ui/test packages/i18n/test
```

See the [root README](../../README.md#web-foundation) for accessibility, localization, launcher,
and planned-flow context.
