# `@local-pii/web`

Accessible, localized React shell for the future local review workflow.

## Responsibilities

- Renders the capability, pinned-policy, and local file-metadata preflight plus the local-processing disclosure.
- Provides a bounded typed client for process-local artifact creation/upload, real asynchronous job
  state/events, cancellation, and value-free detection pagination.
- Runs the authenticated rules-only job and renders localized status, aggregate counts, a bounded
  filterable native detection table, server-owned page controls, and a native conflict table.
- Provides native accept/reject/retype controls whose category choices come from the live capability
  manifest, then saves value-free actions to the server's append-only process-local review history.
- Shows saved review progress across the complete scan, explains that remaining detections follow
  automatic policy, and offers keyboard-focus movement between unreviewed rows on the current page.
- Prevents server-page changes from carrying an unbounded draft batch; the reviewer must save or
  explicitly discard current unsaved decisions before moving pages.
- Keeps exact detected text hidden by default and reveals only the bounded current-page matches from
  the user-selected local file after an explicit action; cleartext never enters API JSON, review
  history, logs, or browser persistence.
- Lets the reviewer explicitly open one bounded local source excerpt at a time, highlights the
  selected match in escaped TXT/Markdown text, and moves focus into the keyboard-scrollable context.
- Creates and verifies a session-only redacted copy through the real shared application core, shows
  its bounded preview, then offers a generic authenticated download without changing the source.
- Provides a two-step accessible clear-workflow action that expires a verified redaction before its
  source scan and resets the file control/UI only after idempotent server cleanup succeeds.
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
to 100 detection rows exposes category, one-based Unicode code-point location, detector confidence,
and evidence-source labels from the server. Up to 100 conflict rows expose only range, possible
categories, and source labels. Matched values and evidence IDs are never returned by the API. The
browser may explicitly reveal the exact current-page matches by deriving them from the already-
selected local file. From a revealed row it can show at most 80 Unicode code points before and 120
after that match in an escaped, focusable source-context region. It retains only those bounded
strings until they are hidden, closed, or the page/file changes. After a conflict-free scan, one action creates and verifies a redacted copy, then shows a
bounded, keyboard-scrollable plain-text preview of at most 4,096 Unicode code points. The user
explicitly downloads the complete output after reviewing that preview. It may
contain sensitive values a detector missed, so pipeline verification is not presented as proof that
the document is safe. Its temporary Blob URL is page-local and the server output exists only for the
current application launch. Explicit workflow cleanup revokes that page reference and asks the API
to release known process-local artifacts/results/review state; downloaded files and browser/runtime/
OS copies are not erased by that action. Redaction always sends the exact current scan job, extraction revision,
review revision, and review digest. Saved accept/reject/retype decisions are applied by the shared
core and bound into the verified output plan; a stale or mismatched set fails closed. The progress
summary counts unique detection targets rather than append-only history entries, and it does not
misrepresent unsaved drafts as decisions already bound into redaction. Boundary edits,
manual additions, conflict decisions, durable resume/history,
retained reports, durable deletion queues/reconciliation, and backup-aware deletion remain unavailable. Running Vite directly intentionally shows the disconnected state
because no trusted API bootstrap is present.

## Development

```sh
pnpm --filter @local-pii/web dev
pnpm --filter @local-pii/web build
pnpm exec vitest run apps/web/test packages/ui/test packages/i18n/test
```

See the [root README](../../README.md#web-foundation) for accessibility, localization, launcher,
and planned-flow context.
