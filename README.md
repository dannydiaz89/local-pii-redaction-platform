# Local PII Redaction Platform

This repository contains a local-first PII redaction platform. It includes the contract foundation
and development TXT/Markdown, JSON, and CSV CLI slices with deterministic scanning, typed-label
replacement, native reopen/rescan verification, an experimental strict DOCX inspect/scan slice,
and an explicitly experimental local Ollama scan path.

Copyright (C) 2026 [dannydiaz89](https://github.com/dannydiaz89). The project is licensed under
`AGPL-3.0-only`; see `LICENSE` and `ATTRIBUTION.md`.

## Prerequisites

- Node.js 24 or newer
- pnpm 10
- Python 3.12 or newer

## Development

```sh
pnpm install
python3 -m venv .venv
.venv/bin/pip install -e 'services/inference-python[dev]'
pnpm generate
pnpm check
pnpm build
pnpm ephemeral:check
pnpm ephemeral:syscall:check
pnpm ephemeral:filesystem-failure:check
pnpm ephemeral:resource:check
```

The default runtime makes no network request and the repository accepts only synthetic fixtures.
The opt-in Ollama path talks only to a numeric loopback address on the same machine.
`pnpm ephemeral:check` builds and spawns the default rules-only CLI with Node filesystem permissions
and an injected network/DNS guard. It proves read-only commands retain no files and successful
redaction adds only the requested verified output inside a disposable workspace. It also sends
real `SIGINT` and `SIGTERM` signals after a private stage exists and proves cancellation removes the
stage without publishing. That permission and final-tree proof is application-level evidence.
Ubuntu CI additionally traces the built rules-only CLI with `strace`: default commands must make
zero network syscalls, read-only and
failure commands must make no filesystem mutations, and successful redaction may only create its
private stage, hard-link the verified output, and unlink the stage. That evidence is Linux-specific;
it does not qualify macOS, Windows, or a network namespace. A separate Linux-only, non-root
subprocess gate uses real directory permissions and a kernel file-size resource limit to exercise
target check, stage creation/write/readback/reopen, publication, and cleanup failures. It proves
canonical privacy-safe errors, documented exit 3, unchanged synthetic inputs and existing outputs,
no partial publication, and cleanup whenever permissions permit it. The file-limit case observes
actual `RLIMIT_FSIZE`/`EFBIG`; it is not an `ENOSPC`, disk-full, quota, or device-failure claim.
A third Linux-only subprocess gate uses GNU `time` numeric high-water measurements across three
cold processes per profile. It enforces conservative absolute peak-RSS ceilings for startup,
oversize rejection, 1 MiB ASCII, 8 MiB ASCII, and 25 MiB Unicode rules-only workloads. A
timing-only checkpoint also measures the exact private-stage logical and allocated blocks and proves
that hard-link publication adds a second pathname for the same inode rather than a second content
allocation. These are Linux CI regression measurements of the current bounded whole-file TXT
implementation, not streaming, controlled reference-hardware, swap, journal, snapshot, or
cross-platform evidence.

## Try the CLI

User-facing document processing runs through the local CLI and the development browser profile. The
browser can execute bounded session-only rules scans and verified redaction downloads; the CLI
remains the interface for explicit output paths, standalone verification, recovery, and
machine-oriented workflows.

```sh
pnpm build
pnpm --silent pii-redact policies list --json
pnpm --silent pii-redact policies explain development-labels --json
pnpm --silent pii-redact policies explain high-risk-disclosure --json
pnpm --silent pii-redact capabilities --json
pnpm pii-redact inspect ./sample-data/input/sample.txt
pnpm --silent pii-redact scan ./sample-data/input/sample.txt --json
pnpm --silent pii-redact redact ./sample-data/input/sample.txt \
  --policy development-labels --output ./test-output/sample.redacted.txt --json \
  > ./test-output/sample.redact-report.json
pnpm --silent pii-redact verify ./test-output/sample.redacted.txt --json \
  > ./test-output/sample.verify-report.json
pnpm --silent pii-redact inspect ./document.json --json
pnpm --silent pii-redact scan ./document.json --json
pnpm --silent pii-redact redact ./document.json \
  --policy development-labels --output ./test-output/document.redacted.json --json
pnpm --silent pii-redact inspect ./document.csv --json
pnpm --silent pii-redact scan ./document.csv --json
pnpm --silent pii-redact redact ./document.csv \
  --policy development-labels --output ./test-output/document.redacted.csv --json
pnpm --silent pii-redact inspect ./document.docx --json
pnpm --silent pii-redact scan ./document.docx --json
pnpm --silent pii-redact cleanup-stages \
  --output ./test-output/sample.redacted.txt --json
```

The tracked `test-output/` directory is a local workspace for generated artifacts and JSON reports;
everything inside it except its `.gitignore` is ignored by Git. Delete or rename an existing output
before rerunning a command because the CLI intentionally never overwrites output files.
`redact` always requires an explicit `--output`; it never silently chooses a destination beside the
input.

## API foundation

[`apps/api`](./apps/api) now provides the first frontend dependency: an unlistened Fastify
composition root and a separate numeric-loopback starter. Each launch generates a 256-bit bearer
token; protected routes enforce that token plus numeric-loopback Host and exact allow-listed browser
Origins. Secret-free health/readiness probes and the authenticated canonical
`GET /v1/capabilities` and `GET /v1/policies` routes are implemented with bounded handlers,
privacy-safe errors, abort propagation, and clean shutdown. The policy catalog exposes only pinned
IDs, versions, digests, risk tiers, and example status; presentation copy stays in the UI catalog.
Authenticated `POST /v1/preview/scan` accepts at most 8 MiB of raw TXT/Markdown bytes for a
process-local rules scan and returns only detection/conflict/category counts. It creates no artifact
or job record and never returns filenames, document values, offsets, or source digests. The additive
`POST /v1/preview/review` route returns at most 100 value-free detection rows and 100 value-free
conflict rows. Detection rows contain only entity type, Unicode code-point offsets, detector
confidence, and bounded evidence-source enums. Conflict rows contain only the overlapping range,
possible entity types, and source enums; evidence IDs and matched values remain server-side. The
aggregate endpoint remains available for clients that do not need locations.
Authenticated `POST /v1/jobs`, `GET /v1/jobs/{jobId}`, idempotent `DELETE /v1/jobs/{jobId}`,
`GET /v1/jobs/{jobId}/events`, and revision-bound `POST /v1/jobs/{jobId}/cancellation` now expose
only pinned operational metadata. The storage-neutral
[`@local-pii/job-store`](./packages/job-store) boundary provides revision, idempotency, transition,
and minimized-event semantics. The development browser profile now adds a bounded process-local
artifact/worker composition: `POST /v1/artifacts` admits digest-bound metadata, a one-use binary
`PUT` supplies at most 8 MiB without a filename, `POST /v1/jobs` starts the real rules scan, and
`GET /v1/jobs/{jobId}/detections` pages value-free results. A v3 job can also run real rules-only
redaction through the shared application core. Only an output that reaches `VERIFIED` is exposed by
`GET /v1/jobs/{jobId}/output` and the authenticated artifact-content download. One worker runs at a
time; scan input buffers are overwritten and released after processing. A verified redacted output
is retained only until application shutdown, and uses a generic download name. Artifact
metadata and result pages also disappear when the application closes. Explicit deletion expires a
completed job and releases its process-local input/output artifacts, result pages, review history,
and review snapshot; minimized `EXPIRED` job/event evidence remains until shutdown. Active jobs
return `409` instead of being silently destroyed. JavaScript strings cannot be reliably zeroized.
Completed scan jobs now also expose a process-local append-only review set:
authenticated GET/POST review-decision routes accept only stable detection IDs, canonical actions,
bounded reason codes, and extraction/job/review revisions. Exact retries replay idempotently and
stale review revisions return `409`; document values and free-form notes are not accepted. This
slice supports accept, reject, and category change. Reviewed redaction now snapshots the exact
conflict-free scan, policy, extraction revision, review revision, and review digest into a v4 job
and v2 immutable plan. Accept applies the configured policy action, reject keeps only that exact
reviewed span, and category change applies the selected supported type. The verifier permits an
intentional rejected residual only at its digest-bound mapped location; any new or shifted residual
still blocks publication. Plans, reports, and API records contain offsets and provenance but never
matched values. Boundary edits, manual additions, durable artifact/review persistence, reports,
and restart/resume remain disabled.

[`@local-pii/adapter-job-sqlite`](./packages/adapter-job-sqlite) is a metadata-only development
prototype behind that same port. It proves private-file creation, schema-version rejection,
transactional revision/event updates, idempotent replay after restart, and stale-write rejection
across connections. It uses Node's experimental built-in SQLite API and is not composed into the
CLI or browser launcher. It does not qualify retention, encryption, backup, leases, an outbox, or a
production durable profile. Filesystem evidence assumes a trusted owner-only POSIX directory;
same-owner path replacement races and Windows permission semantics remain open.

## Web foundation

[`apps/web`](./apps/web) now provides the first local review-application shell. It uses React with
shared accessible primitives and semantic tokens from [`packages/ui`](./packages/ui), and all of
its current user-facing copy comes from the typed, bundled catalog in
[`packages/i18n`](./packages/i18n). The canonical English source lives independently in
[`packages/i18n/src/catalogs/en.ts`](./packages/i18n/src/catalogs/en.ts); future human locale
catalogs belong beside it. English is the only user-selectable presentation today; expansion and
RTL pseudolocales remain test-only layout gates. The shell uses native landmarks and controls, visible focus, logical CSS properties,
reduced-motion and forced-colors accommodations, and automated axe checks. Manual keyboard,
screen-reader, zoom/reflow, and contrast review remain required before accessibility qualification.

The capability preflight accepts only a numeric-loopback API origin and a per-launch bearer token
in the in-memory `window.__LOCAL_PII_BOOTSTRAP__` launcher object. It does not read build-time
secrets, local/session storage, cookies, or remote catalogs. Its bounded client denies redirects,
credentials, referrers, and caching, then projects only aggregate values from the capability
response. A separate bounded, typed client now discovers the pinned policy catalog, creates a
process-local artifact and real asynchronous rules-scan job, observes its state/events, and requests
value-free detection pages. Once connected, document intake admits TXT/Markdown files up to 8 MiB.
The UI displays the server-owned completion state/event count plus aggregate categories and a
native, filterable detection table with server-owned 100-row page controls. Up to 100 unresolved
conflict locations remain visible in a separate native table. Wide tables remain
keyboard-scrollable at narrow viewports. Each accepted detection now has native review controls for
accept, reject, or changing to an entity type advertised by the live capability manifest. Saved
actions go to the server-authoritative append-only process-local review set with explicit stale-
revision feedback; they are not stored in browser persistence. The UI reports saved review progress
against the full detection total and states explicitly that detections without a saved decision
still follow the automatic policy. Previous/next unresolved controls move keyboard focus among the
visible filtered rows, and server-page changes are blocked until drafts are saved or explicitly
discarded. The detection table keeps matched
text hidden by default. An explicit reveal reads only the bounded matches for the current page from
the already-selected local file, using the server-owned Unicode code-point locations. Cleartext is
never added to an API response or review record and is released from UI state when hidden, the page
changes, or the file changes. A reviewer can then open one escaped source-context excerpt at a time:
at most 80 Unicode code points before and 120 after the selected match, with the match highlighted
and keyboard focus moved into the excerpt. Context is also local-only and cleared when closed or
when its owning page/file changes; JavaScript strings cannot be reliably zeroized. For a conflict-free completed scan
with an exact current review set, the UI can start a second process-local job that applies the
selected pinned policy plus saved accept/reject/retype decisions, reopens and verifies the derived
bytes, and shows an escaped plain-text preview only after the server reaches `VERIFIED`. The original
file remains unchanged. The preview is bounded to the first 4,096 Unicode code points, and the user
explicitly downloads the complete output afterward through a generic link. Because the preview is
derived document content, it may contain sensitive values a detector missed; it is not a declaration
that the file is safe. The browser uses a temporary Blob URL for the current page and the server
retains the output only for the current application launch. A two-step “Clear current workflow”
action expires a completed redaction before its source scan, clears the native file control and UI
references only after both requests succeed, and can be retried idempotently. Files already
downloaded remain user-owned; browser/runtime/OS copies are outside this session-cleanup guarantee.
It retains nothing in browser
persistence and sends no filename or matched value back in JSON responses. This is session-only
processing, not the durable review store. Until the
trusted local launcher injects its session, the standalone preview correctly shows a disconnected
state. Review is partially implemented: accept/reject/retype persistence, reviewed redaction, and
completed-session workflow expiration are active, while boundary/manual actions, durable
resume/history, retained reports, deletion queues/reconciliation, and backup-aware deletion remain
intentionally open.

The development local launcher now provides that handoff on macOS and Linux. It builds the application,
starts one numeric-loopback origin for both the web shell and API, and gives the OS browser opener a
non-secret, one-shot loopback URL. That response introduces a separate 256-bit bootstrap path, and
only the matching one-time script serves the bearer. The launch page never contains the bearer; the
web entry point removes its bootstrap object and script element immediately and replaces the visible
launch URL. Browser responses enforce a same-origin CSP plus framing, permissions, referrer, opener,
and resource-policy headers. The server does not print the bootstrap nonce or bearer.

```sh
pnpm start:local
pnpm --filter @local-pii/web dev
pnpm --filter @local-pii/web build
pnpm exec vitest run packages/i18n/test/i18n.test.ts \
  packages/ui/test/ui.test.tsx apps/web/test/api.test.ts apps/web/test/application.test.tsx
```

`cleanup-stages` is a bounded recovery tool for an interrupted redaction. It is a dry run unless
`--apply` is supplied, considers only private stages older than 24 hours that match the exact
selected output, and reports counts without filenames or paths. Run it only in a trusted directory:
the generated UUID filename sharply limits candidates but is not cryptographic proof that the
application owns a file. To remove eligible stages after reviewing the dry run:

```sh
pnpm --silent pii-redact cleanup-stages \
  --output ./test-output/sample.redacted.txt --apply --json
```

Every rules-only `redact` is policy-bound. When `--policy` is omitted, the CLI explicitly selects
and reports `development-labels` for compatibility. `redact` never overwrites its input or an
existing output. It writes to a private staging file,
reopens the staged UTF-8 artifact, rescans it, and publishes the requested path only when the
`text-rescan-v1` profile passes. Machine reports contain entity types and offsets, not matched
values. Redaction reports also expose privacy-safe provenance digests binding the exact input,
resolved detector evidence, capability snapshot, policy, detector bundle, and writer used by the
plan. The text adapter now applies that immutable plan itself and returns a writer receipt. Core
independently reconciles the receipt's exact action IDs and counts before verification and
publication. A canonical v2 verification attestation then binds the exact input and reopened
output bytes, immutable plan, policy, capability snapshot, writer receipt, verification profile,
verifier, checks, and reconciliation counts under a report digest. The public JSON report exposes
only privacy-safe identities, digests, and bounded counts. The standalone `verify` command is a
residual scan of the supplied artifact; it does not claim plan execution, policy compliance, or
publication eligibility.

The rules-only CLI also supports bounded UTF-8 `.json` documents through
[`@local-pii/adapter-json`](./packages/adapter-json). The adapter parses native JSON, rejects
duplicate object keys and malformed or overly complex structures, and extracts string values in
document order using an internal JSON Pointer source map. Object keys are deliberately neither
scanned nor transformed. A redaction action must fit wholly inside one value; crossing a value
boundary fails closed. Untouched keys, whitespace, ordering, numbers, booleans, nulls, and string
tokens remain byte-identical. A changed string token is emitted with standard JSON escaping. The
private same-directory stage is reparsed as JSON and its extracted values are rescanned before the
existing no-clobber publication boundary commits it. JSON support is currently CLI-only and
rules-only; the browser/API continue to advertise and accept TXT/Markdown until their structured
preview and review mapping is implemented. JSON Lines, streaming, key transformation, path-aware
policy rules, and structured-path evidence in public reports remain open.
JSON redaction requires the selected output path to retain a `.json` extension.

The rules-only CLI also supports bounded UTF-8 `.csv` documents through
[`@local-pii/adapter-csv`](./packages/adapter-csv). The adapter detects comma, tab, or semicolon
delimiters only when the result is unambiguous, supports standard doubled-quote escaping and quoted
newlines, and requires a uniform row width. It extracts decoded cells in row-major order and binds
their row/column coordinates into the private extraction revision. Every cell—including the first
row—is currently scanned; the adapter does not guess whether a row is a header. Redaction actions
must remain inside one cell. Untouched field tokens, delimiters, quotes, and line endings stay
byte-identical; changed fields retain their quoted form and are escaped when required. The private
stage is reparsed as CSV and its cells are rescanned before no-clobber publication. CSV support is
currently CLI-only and rules-only. Explicit dialect/header configuration, structured/free-text
column policies, public cell-location evidence, and streaming/million-row qualification remain
open. Formula-like cells are treated as untrusted text: the CLI never evaluates them, but unchanged
formula tokens are not neutralized for spreadsheet software. CSV redaction requires the selected
output path to retain a `.csv` extension.

JSON values, CSV cells, and DOCX paragraphs now expose a versioned typed source map internally:
RFC 6901 JSON pointers, one-based logical CSV row/column coordinates, or an allow-listed DOCX part
and one-based paragraph. Core validates that every structured detection belongs to exactly one
declared region, and span resolution binds those native locations into its digest. These locations
are deliberately omitted from ordinary CLI/API reports because paths and headers can themselves be
sensitive. Path/cell-aware policy selection and native targets carried directly in a future plan
contract remain open; this source-map foundation is the durable seam for that work.

The rules-only CLI has an experimental strict `.docx` inspect/scan surface through
[`@local-pii/adapter-docx`](./packages/adapter-docx). It accepts only bounded, non-encrypted OOXML
packages whose declared visible content is ordinary `w:t` text in `word/document.xml` body and
table paragraphs, including text fragmented across formatting runs. It rejects macros, external
or embedded relationships, metadata and auxiliary parts, headers/footers/notes/comments, images,
text boxes, fields, revisions, hidden text, custom XML, unknown parts, and unsafe or inconsistent
ZIP structures instead of silently skipping them. Its `docx-extract-v1` evidence attests bounded
ZIP structure, the feature allowlist, and native paragraph mapping only. DOCX redaction and
standalone verification are not exposed: native leakage verification, broader feature coverage,
sandboxed parsing, independent Office-renderer fidelity, and malicious-corpus qualification remain
Milestone 4 work.

`policies explain` is read-only: it compiles a bundled example and compares its requirements with
the current rules-only file capabilities without opening a document or contacting Ollama. The
`development-labels` example is currently satisfiable. `high-risk-disclosure` is deliberately
reported as unsatisfiable because the available components are not qualified for high-risk use and
the required detector, transformation, and verification assurances are incomplete. Policy
inspection is also available separately, while `redact --policy development-labels` now enforces
its confidence and exact supporting-evidence requirements before staging an output. Selecting
`high-risk-disclosure` for redaction fails before the document is read because the current local
components do not satisfy that policy's qualification and capability requirements.

To compare the rules with an already-installed local Ollama model, run an experimental hybrid scan:

```sh
ollama pull phi4-mini:3.8b
pnpm --silent pii-redact scan ./sample-data/contextual/development/contextual-development-positive.txt \
  --engine ollama --model phi4-mini:3.8b --allow-experimental --json
```

The application never pulls a model itself. Ollama must already be running, and the requested model
must be installed with a digest reported by Ollama. The provider accepts only unauthenticated numeric
loopback URLs; `--ollama-url http://127.0.0.1:11434` and `--timeout-ms 60000` may be supplied
explicitly. This path is scan-only, bounded to 80,000 input bytes/20,000 Unicode code points, and
fails closed rather than silently falling back to rules-only behavior.

The experimental model contract asks Ollama only for an entity type and an exact verbatim value.
Local deterministic code then requires one exact case- and normalization-sensitive occurrence in
the canonical input and calculates trusted half-open Unicode code-point offsets. Missing,
ambiguous, malformed, or over-limit values invalidate the entire model response. Identical model
entries are deduplicated only after anchoring; different classifications at the same span continue
through the existing conflict resolver. The numeric model-evidence confidence is a conservative,
uncalibrated provider constant. Exact anchoring proves where text occurs, not that the model's
classification is correct or complete.

Those additional verbatim values necessarily exist transiently in the local Ollama request,
response, and application parsing path. The application does not put them in CLI reports, errors,
detection IDs, evaluator reports, or audit material. Ollama process caches, logs, diagnostics,
swap, and other host/runtime state remain outside that application-level guarantee.

The six contextual types in this Ollama profile are deliberately fixed so its prompt, structured
schema, capability descriptor, corpus, and evaluation digest describe one reproducible experiment.
They are a subset of the platform's versioned canonical entity catalog, not the long-term extension
mechanism. A future import flow is expected to activate a reviewed, digest-pinned model or detector
bundle whose manifest declares supported canonical entity types; policy selection and capability
preflight will then choose only the supported intersection. Unknown free-form labels will continue
to fail schema validation. Adding a new core type requires a versioned contract change, while
organization-specific types must use the separately governed `CUSTOM`/installed-detector design.
The current CLI does not yet expose model-bundle import or arbitrary runtime taxonomy changes.

`SIGINT` and `SIGTERM` request cooperative cancellation. The CLI waits for in-flight cleanup and
returns the canonical `OPERATION_CANCELLED` error without publishing an unverified output. Signal
exit codes are `130` for `SIGINT` and `143` for `SIGTERM`.

Other exit codes are `0` for success, `2` for usage, `3` for processing or incomplete recovery,
`4` for failed verification, `5` for unresolved scan conflicts or policy review, and `6` for
output collisions.

## Current limitations

- The rules-only CLI accepts UTF-8 `.txt`, `.md`, `.markdown`, `.json`, and `.csv` regular files for
  inspect/scan/redact/verify. Its narrow experimental `.docx` surface is inspect/scan only. Symbolic
  links are rejected. The current browser/API intake remains TXT/Markdown-only.
- Rules-only remains the default. It covers email, general phone shapes, structurally valid US SSNs,
  Luhn-valid payment cards, IPv4/IPv6, and explicit API-key/access-token/password assignments.
- The opt-in Ollama hybrid scan is experimental and unqualified. Its contextual results can be
  incomplete or semantically incorrect. The prior offset-supplying `phi4-mini` experiment produced
  zero exact matches on the small frozen harness; that historical result does not describe the new
  verbatim-plus-local-anchoring contract. The harness is useful for integration and model
  comparison, not release qualification, and no model is currently qualified.
- The verification profile is a deterministic residual rescan, not a claim that all PII classes or
  contextual entities were detected.
- Cooperative cleanup cannot run after `SIGKILL`, a process or host crash, power loss, or some
  filesystem failures. Orphan-stage unlinking is not secure erasure and does not remove copies from
  filesystem journals, snapshots, backups, swap, or provider logs. Recovery is an explicit
  operator action in a trusted directory because stage-like filenames are not ownership proofs.
- The verified hard link is the publication commit. If removing its private staging link cannot be
  confirmed afterward, the command returns a non-retryable storage error and the verified output may
  already exist at the output path you selected. Inspect that path before retrying, then use the
  dry-run recovery command. The adapter does not claim directory-entry durability across power loss.
- Real Linux permission-denied and `RLIMIT_FSIZE`/`EFBIG` subprocess evidence complements the
  deterministic adapter fault seam. Real `ENOSPC`, `EDQUOT`, inode exhaustion, device/I/O failure,
  hostile filesystem races, and equivalent macOS/Windows behavior remain unproven.
- TXT/Markdown, JSON, CSV, and DOCX CLI processing currently materialize bounded whole files and are not
  streaming implementations. Linux peak-RSS and private-stage byte profiles are regression evidence, not a
  hard runtime memory limit or proof that swap, core dumps, filesystem journals, snapshots, or
  shell redirection retained no bytes. Controlled reference-hardware and cross-platform resource
  qualification remain open.
- There is no durable upload or retained asynchronous job-processing HTTP API, activated durable job-store
  profile, qualified contextual model, or durable review workflow yet. A metadata-only SQLite prototype
  exercises restart and transaction semantics but remains disabled and unqualified for production.
  The authenticated development profile accepts bounded raw bytes in memory and returns aggregate
  counts plus server-owned pages of at most 100 value-free detection locations. Job create/status/
  events/cancellation/expiration routes use volatile process-local stores, retain nothing after
  process exit, and do not durably store document content.
  The implemented web shell is limited to secured capability/policy preflight, process-local
  rules-only scan/review, and a verified session redaction download. Its design-system and
  localization foundations are active, but durable review decisions, restart/resume, retention,
  reports, and durable lifecycle deletion remain unavailable; explicit completed-session workflow
  expiration is implemented.
- The automatic trusted-browser launcher currently supports macOS and Linux. Windows browser
  launch and packaged-install path qualification remain open. The OS opener receives no secret in
  its process arguments. The external-browser handoff does not defend against an adversarial local
  process that discovers the loopback port and races the first one-shot launch request; closing that
  gap requires a packaged webview or a private OS-mediated handoff.
- This is development software and must not be treated as a compliance certification or a guarantee
  that a document contains no sensitive data.

## Repository layout

- [`apps/api`](./apps/api): loopback HTTP composition, local web serving, and launcher lifecycle
- [`apps/cli`](./apps/cli): terminal adapter for inspect, scan, redact, verify, and recovery commands
- [`apps/web`](./apps/web): accessible, localized React capability and review shell
- [`packages/contracts`](./packages/contracts): canonical schemas, OpenAPI, generated types, and validation
- [`packages/domain`](./packages/domain): dependency-free identifiers, errors, evidence, spans, and job states
- [`packages/policy`](./packages/policy): immutable policy validation, compilation, and capability explanations
- [`packages/detectors`](./packages/detectors): bounded deterministic and composite evidence providers
- [`packages/span-resolution`](./packages/span-resolution): deterministic overlap handling and explicit conflicts
- [`packages/redaction`](./packages/redaction): immutable typed-label plans and application
- [`packages/adapter-text`](./packages/adapter-text): strict UTF-8 input and staged, non-overwriting writes
- [`packages/adapter-csv`](./packages/adapter-csv): native CSV cell extraction, dialect mapping, and cell-only writes
- [`packages/adapter-docx`](./packages/adapter-docx): strict experimental DOCX paragraph extraction and source mapping
- [`packages/adapter-json`](./packages/adapter-json): native JSON value extraction, mapping, and value-only writes
- [`packages/verification`](./packages/verification): privacy-minimized deterministic residual verification
- [`packages/core`](./packages/core): use-case orchestration and provider/adapter ports
- [`packages/profile-local`](./packages/profile-local): reusable rules-only and experimental local composition
- [`packages/provider-ollama`](./packages/provider-ollama): experimental loopback-only contextual provider
- [`packages/i18n`](./packages/i18n): typed bundled catalogs and locale helpers
- [`packages/job-store`](./packages/job-store): revisioned, idempotent job-metadata port and volatile conformance adapter
- [`packages/adapter-job-sqlite`](./packages/adapter-job-sqlite): disabled metadata-only SQLite transaction/restart prototype
- [`packages/ui`](./packages/ui): accessible React primitives and semantic design tokens
- [`services/inference-python`](./services/inference-python): Python contract boundary and generated Pydantic models
- `fixtures/contracts`: synthetic valid and invalid cross-language examples
- `tooling`: deterministic generation and dependency-boundary checks
