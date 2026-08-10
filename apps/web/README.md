# `@local-pii/web`

Accessible, localized React shell for the future local review workflow.

## Responsibilities

- Renders the capability, pinned-policy, and local file-metadata preflight plus the local-processing disclosure.
- Provides a bounded typed client for process-local artifact creation/upload, real asynchronous job
  state/events, cancellation, and value-free detection pagination.
- Runs the authenticated rules-only job and renders localized status, aggregate counts, a bounded
  filterable native detection table, server-owned page controls, and a native conflict table.
- Creates and verifies a session-only redacted copy through the real shared application core, then
  starts a generic authenticated download without changing the selected source file.
- Renders only the first 4,096 Unicode code points of the verified output as escaped plain text;
  document markup is never executed and the complete downloaded file remains the final output.
- Keeps wide result tables keyboard-scrollable on narrow viewports.
- Consumes the one-time in-memory launcher bootstrap without browser persistence.
- Uses shared primitives and semantic tokens from `@local-pii/ui`.
- Resolves all user-facing copy through bundled catalogs in `@local-pii/i18n`.
- Keeps expansion and RTL pseudolocales available to tests while exposing English only, alongside
  reduced-motion, forced-colors, and automated accessibility coverage.

## Current scope

The application accepts a TXT or Markdown file up to 8 MiB, sends only its raw bytes to the
same-origin numeric-loopback API, and creates a session-only artifact and real scan job. The
filename is not sent and neither bytes nor results enter browser persistence or durable storage.
Artifact/job metadata and value-free results disappear when the application closes. Each page of up
to 100 detection rows exposes only category, one-based Unicode code-point location,
detector confidence, and evidence-source labels. Up to 100 conflict rows expose only range,
possible categories, and source labels; matched values and evidence IDs are not returned or
rendered. After a conflict-free scan, one action creates, verifies, and downloads a redacted copy;
a download-again link remains available if the browser blocks or the user needs another copy. A
bounded, keyboard-scrollable plain-text preview shows at most 4,096 Unicode code points. It may
contain sensitive values a detector missed, so pipeline verification is not presented as proof that
the document is safe. Its temporary Blob URL is page-local and the server output exists only for the
current application launch. The application does not provide durable resume/history, editable
review decisions, retained reports, or lifecycle deletion. Running Vite directly intentionally shows the disconnected state
because no trusted API bootstrap is present.

## Development

```sh
pnpm --filter @local-pii/web dev
pnpm --filter @local-pii/web build
pnpm exec vitest run apps/web/test packages/ui/test packages/i18n/test
```

See the [root README](../../README.md#web-foundation) for accessibility, localization, launcher,
and planned-flow context.
