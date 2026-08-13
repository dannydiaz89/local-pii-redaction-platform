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
pnpm --silent pii-redact batch scan ./sample-data/input \
  --include '**/*.txt' --exclude '**/ignored-*' --json
mkdir -m 700 ./test-output/batch-redacted
pnpm --silent pii-redact batch redact ./sample-data/input \
  --output ./test-output/batch-redacted --policy development-labels --json \
  > ./test-output/batch.redact-report.json
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
pnpm --silent pii-redact inspect ./synthetic-literal-profile.pdf --json
pnpm --silent pii-redact cleanup-stages \
  --output ./test-output/sample.redacted.txt --json
```

Batch automation that explicitly accepts a mixed result can add `--allow-partial`. Its JSON outcome
remains `PARTIAL` with aggregate failure-code counts even when the command returns zero. The option
never converts an all-failed batch or a completed result requiring review into success. The
canonical report records `completionPolicy` as `REQUIRE_COMPLETE` or `ALLOW_PARTIAL` so downstream
consumers do not have to infer the invocation policy from an exit status:

```sh
pnpm --silent pii-redact batch scan ./sample-data/input --allow-partial --json \
  > ./test-output/batch.scan-report.json
node -e 'const fs = require("node:fs"); const report = JSON.parse(fs.readFileSync("./test-output/batch.scan-report.json", "utf8")); console.log(report.completionPolicy, report.outcome, report.manifest.failedFileCount)'
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

The real HTTP boundary also has a bounded abuse/disconnect evidence slice. It rejects malformed,
oversized, or conflicting authentication and request framing without reflecting planted values;
recognizable PDF/archive container signatures cannot be retained through the TXT/Markdown upload
route; and a real client socket disconnect aborts non-cooperative application work. These tests use
Node's numeric-loopback HTTP/1.1 behavior. Proxy/reverse-proxy smuggling, HTTP/2, multi-principal
authorization, durable-object authorization, and a complete Windows/macOS CI matrix remain open.

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

The default screen is deliberately tool-first: choose a file, scan it, review the findings, then
create and download a redacted copy. Successful startup diagnostics no longer occupy a separate
preflight panel. Session, capability, policy, and privacy details remain available through a
collapsed native disclosure, while connection failures stay visible with a retry action.

The capability preflight accepts only a numeric-loopback API origin and a per-launch bearer token
in the in-memory `window.__LOCAL_PII_BOOTSTRAP__` launcher object. It does not read build-time
secrets, local/session storage, cookies, or remote catalogs. The browser consumes the public root
of [`@local-pii/sdk`](./packages/sdk). Its bounded session client denies redirects, credentials,
referrers, and caching, rejects incompatible capability-contract versions before any upload, then
projects only aggregate values from the capability response. Its root-only package exports and
fresh declaration-emit baseline make every public runtime or type change an explicit compatibility
review without claiming that this private package is already published or semantically versioned.
The same typed client discovers the pinned policy catalog, creates a
process-local artifact and real asynchronous rules-scan job, observes its state/events, and requests
value-free detection pages. Once connected, document intake admits TXT/Markdown, JSON, and CSV files up to 8 MiB.
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
text hidden by default. For TXT/Markdown, an explicit reveal reads only the bounded matches for the current page from
the already-selected local file, using the server-owned Unicode code-point locations. Cleartext is
never added to an API response or review record and is released from UI state when hidden, the page
changes, or the file changes. A reviewer can then open one escaped source-context excerpt at a time:
at most 80 Unicode code points before and 120 after the selected match, with the match highlighted
and keyboard focus moved into the excerpt. Context is also local-only and cleared when closed or
when its owning page/file changes; JavaScript strings cannot be reliably zeroized. JSON/CSV reveal
and source context stay disabled because canonical structured offsets are not raw-file offsets and
native locations remain private. For a conflict-free completed scan
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
existing no-clobber publication boundary commits it. JSON is rules-only in the CLI and bounded
process-local browser/API transport. The API uses the same native parser, in-memory native stage,
native reopen, and generic names without exposing JSON pointers. A v2 external policy can classify an exact RFC 6901
JSON Pointer as one configured entity type while all other values retain free-text detection.
JSON Lines, streaming, key transformation, wildcard selectors, and structured-path evidence in
public reports remain open.
JSON redaction requires the selected output path to retain a `.json` extension.

The rules-only CLI also supports bounded UTF-8 `.csv` documents through
[`@local-pii/adapter-csv`](./packages/adapter-csv). The adapter detects comma, tab, or semicolon
delimiters only when the result is unambiguous, supports standard doubled-quote escaping and quoted
newlines, and requires a uniform row width. A v2 policy can instead select the delimiter explicitly,
declare the first logical row as a byte-preserved, unscanned header, and classify exact one-based
columns or exact header names as configured entity types. Without that explicit declaration every
cell—including the first row—is scanned; the adapter never guesses whether a row is a header.
Redaction actions must remain inside one cell. Untouched field tokens, delimiters, quotes, and line
endings stay byte-identical; changed fields retain their quoted form and are escaped when required.
The private stage is reparsed as CSV and its cells are rescanned before no-clobber publication. CSV
is rules-only in the CLI and bounded process-local browser/API transport. Wildcard/ignore selectors,
public cell-location evidence, and streaming/million-row qualification remain open. Formula-like
cells are treated as untrusted text: the CLI never evaluates them, but unchanged formula tokens are
not neutralized for spreadsheet software. CSV redaction requires the selected output path to retain
a `.csv` extension.

JSON values, CSV cells, DOCX paragraphs, and qualified DOCX XML value carriers now expose an
append-only versioned typed source map internally: RFC 6901 JSON pointers, one-based logical CSV
row/column coordinates, an allow-listed DOCX part and paragraph, or value-free carrier metadata.
Relationship targets use their owning content part and stable relationship ID; target values are
never stored in the location. Core validates that every structured detection belongs to exactly one
declared region, while permitting tab-separated nonoverlapping DOCX regions to retain one stable
part/paragraph identity; span resolution `0.3.0` binds those native locations into its digest. These locations
are deliberately omitted from ordinary CLI/API reports because paths and headers can themselves be
sensitive. Exact path/cell policy selection now uses this source-map seam. Carrying native targets
directly in a future plan contract and cross-checking them at the writer boundary remain future
hardening.

Exact structured selection is supplied through one bounded JSON policy file (maximum 256 KiB):

```sh
pnpm --silent pii-redact scan ./records.json --policy-file ./policy.json --json
pnpm --silent pii-redact redact ./records.csv \
  --policy-file ./policy.json --output ./records.redacted.csv --json
```

The CLI accepts policy schema v1 or v2 and rejects symlinks, malformed JSON, unknown fields,
duplicate/conflicting selectors, header-name selectors without an explicit `PRESENT` header mode,
and files over the bound. `--policy-file` is mutually exclusive with bundled `--policy` selection
and with experimental Ollama. There is no YAML, include, environment-variable, executable, or
network-backed policy loading. Structured classification confidence `1` means the source region was
selected exactly by trusted configuration; it does not independently prove the semantic label is
correct. Paths, pointers, header names, and policy file locations stay out of ordinary reports.
External-policy scans use the append-only scan-report v2 contract and external-policy redactions use
redact-report v3; existing scan v1 and bundled-policy redaction v2 reports remain unchanged.

The rules-only CLI has an experimental strict `.docx` inspect/scan surface through
[`@local-pii/adapter-docx`](./packages/adapter-docx). It accepts only bounded, non-encrypted OOXML
packages whose declared visible content is ordinary `w:t` text in `word/document.xml` body and
table paragraphs or in strictly related headers, footers, footnotes, and endnotes, including text
fragmented across formatting runs. Tabs and note-reference markers become non-crossable structural
boundaries; standard reserved nonpositive-ID note separators remain zero-text. Content types, relationships,
header/footer references, and ordinary note IDs must form a closed graph. Version 0.4 also scans
bounded external HTTPS/mailto hyperlink targets without dereferencing them, generated numbering
templates, style/font metadata, core/extended document properties, and one exact zero-text
bibliography custom-XML graph through typed relationship/XML-value regions. Strict Word-generated
settings, numbering, styles, font tables, a zero-text decorative drawing/`AlternateContent` profile,
one exact Office theme, and empty web settings require closed namespaces, parents, ordering,
cardinality, attributes, relationships, and content types. Macros, non-hyperlink external or embedded
relationships, comments, text boxes, fields, revisions, hidden text/styles, binary objects, unknown
parts, and any non-qualified carrier shape still fail closed instead of being skipped. Privacy-safe
unsupported errors expose only a closed reason category. XML input and internal replacement strings
must satisfy the XML 1.0 character repertoire. Its `docx-extract-v1` evidence attests bounded ZIP
structure, the feature allowlist, and typed native source mapping only. Version 0.5 extends the
experimental writer across paragraph/run text and every accepted typed relationship/XML carrier.
It binds exact raw carrier ranges, XML-escapes attribute/text replacements, reparses changed external
targets and the complete OOXML package before staging, and reconciles the exact plan/receipt,
deterministic staged bytes, native reopen, canonical replacements, retained carrier inventory,
untouched decompressed parts, and uniquely planted planned-source canaries on synthetic packages.
The reconciliation deliberately reuses the extraction parser and reports no independent or fidelity
qualification. A separate non-authorizing foundation in `@local-pii/verification` now uses its own
bounded ZIP/XML/content-type/relationship parser, independently enumerates retained XML carriers,
for inputs already accepted by the adapter, reconstructs the complete frozen paragraph/relationship/
XML source-carrier order and canonical source map,
independently reproduces the `docx-extraction:v3` revision across fragmented run nodes, reconciles exact
per-carrier native deltas with the plan and writer receipt, rejects omitted or unplanned package/carrier
changes, and runs privacy-safe unique-canary plus deterministic residual scans. Exact `REJECT` review
decisions may retain only the matching entity at its action-adjusted canonical output offsets; forged
or shifted offsets do not suppress residuals. These remain caller-supplied review semantics until a
core-bound compiled-plan integrity check exists. The foundation also validates and hashes the supplied
input/output, capability, policy, plan, receipt, writer, application, media type, output extraction
revision, and bounded clock inputs required by a future application attestation. That internal digest
binds the complete supplied plan/review semantics but does not independently recompute the compiled
plan identity, so the digest binds what was supplied without authenticating that it was the plan the
application compiled. It is not the canonical verification attestation and cannot be consumed as one. It never
imports the DOCX adapter, writes or publishes a file, and always reports fidelity and publication as
unverified. DOCX redaction and standalone verification therefore remain unexposed: complete independent
feature-grammar equivalence and malicious-input qualification, a core-bound verification attestation,
canonical DOCX verification profile/report integration, broader feature coverage,
sandboxed parsing, independent Office-renderer fidelity, and malicious-corpus qualification remain
Milestone 4 work.

The rules-only CLI also has an experimental, synthetic-only `.pdf` inspection foundation through
[`@local-pii/adapter-pdf`](./packages/adapter-pdf). It accepts only an exact PDF 1.4 header or a PDF
1.7 header followed by a bounded all-binary comment, one complete classic xref revision, a closed
catalog/flat-page graph, one uncompressed or bounded exact Flate content stream per page, and
bounded visible ASCII literal text using built-in Helvetica/WinAnsi and a closed `BT`/`Tf`/`Td`/
`Tj`/`ET` operator set. Canonical reading order is page order followed by operator order. Version
0.2 emits a complete frozen source map for that accepted surface: each canonical text item has a
value-free v3 location containing page, page/content/font object numbers, text-item ordinal, and
exact glyph count. Unknown or unused objects, operators, encodings, filters, or dictionaries fail
closed. One exact inline `/OpenAction [page-reference /XYZ null null 0]` (with the separator before
`[` optional) may identify a declared page as the non-executable initial view; it has no canonical
value or skipped source-map carrier.
Version 0.5 also admits only a paired, closed Info/XMP metadata grammar. Every accepted metadata
value is included in canonical text and receives a value-free v4 carrier/object/field/occurrence
location; namespace spoofing, duplicate attributes, arbitrary XML nesting, document IDs, unknown
fields, and unpaired metadata fail closed. This is extraction provenance, not metadata sanitization.
Named/string destinations, action dictionaries, and every other action shape fail closed, as do
encryption, incremental updates, broader metadata, JavaScript, forms/XFA, annotations, attachments,
optional content, images, XObjects, alternate fonts, scanned/mixed pages, and selected-file
symlinks. The
capability is `EXPERIMENTAL`, `EXTRACT_ONLY`, and advertises only probe/inspect. Scan is blocked
pending end-to-end admission/security qualification of the new strict-profile source map, while
real-world scanning remains blocked on broader compressed carriers, tagging/metadata coverage,
fonts, operators, and qualified Unicode mapping; the narrow Flate support does not admit object/xref
streams, filter arrays, predictors, trailing data, or other compressed carriers. Redaction,
verification, rendering/preview, and OCR are also unavailable. This does not resolve
OQ-009: production PDF parser/writer/verifier selection, licensing, independent extraction, native
search/copy checks, renderer canaries, fidelity, and sandbox qualification remain open.

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

Other exit codes are `0` for complete success or an explicitly accepted conflict-free partial batch,
`2` for usage, `3` for processing or incomplete recovery,
`4` for failed verification, `5` for unresolved scan conflicts or policy review, and `6` for
output collisions.

## Current limitations

- The rules-only CLI accepts UTF-8 `.txt`, `.md`, `.markdown`, `.json`, and `.csv` regular files for
  inspect/scan/redact/verify. Its narrow experimental `.docx` surface is inspect/scan only. Symbolic
  links are rejected. The current browser/API intake supports TXT/Markdown/JSON/CSV only.
- `batch scan` recursively processes only TXT/Markdown/JSON/CSV beneath one non-symbolic directory.
  Traversal is deterministic and bounded to 1,000 files, 1,000 directories, 10,000 entries,
  256 MiB of selected input, 32 include and 32 exclude patterns, and a 60-second cooperative
  deadline by default. Glob matching uses a deterministic automaton rather than backtracking regexes,
  with an 8,192-code-unit relative-path limit and a 100-million-state-step traversal budget. Its
  canonical manifest contains aggregate counts and fixed error-code counts only: no paths,
  filenames, patterns, content digests, native locations, or values. Per-file safe failures produce
  a nonzero partial/failed manifest by default. Explicit `--allow-partial` changes only a mixed,
  conflict-free partial result to exit success; the manifest remains `PARTIAL`, and an all-failed
  manifest remains nonzero. The report always records the selected completion policy. Recursive
  `batch redact` uses the same bounds for rules-only verified TXT/Markdown/JSON/CSV publication.
  It requires a separate existing output root, preserves deterministic relative paths, and checks
  the complete target set for existing outputs, duplicate case-folded mappings, containment, and
  observed symbolic parents before any content processing. Each file uses the existing private
  stage, reopen, verification, hard-link no-clobber publication, and cleanup workflow. A per-file
  safe failure produces a privacy-safe `PARTIAL` or `FAILED` aggregate report and always returns
  nonzero; `--allow-partial` is scan-only. Already verified outputs from earlier files are not
  rolled back. Resume and Ollama batch processing remain unavailable. Complete mediation of a hostile process concurrently replacing
  parent-directory entries requires a future dirfd/openat-style traversal boundary.
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
- [`packages/adapter-pdf`](./packages/adapter-pdf): strict synthetic-only PDF inspection foundation
- [`packages/adapter-json`](./packages/adapter-json): native JSON value extraction, mapping, and value-only writes
- [`packages/verification`](./packages/verification): privacy-minimized deterministic residual verification
- [`packages/core`](./packages/core): use-case orchestration and provider/adapter ports
- [`packages/profile-local`](./packages/profile-local): reusable rules-only and experimental local composition
- [`packages/provider-ollama`](./packages/provider-ollama): experimental loopback-only contextual provider
- [`packages/sdk`](./packages/sdk): bounded authenticated numeric-loopback TypeScript session client
- [`packages/i18n`](./packages/i18n): typed bundled catalogs and locale helpers
- [`packages/job-store`](./packages/job-store): revisioned, idempotent job-metadata port and volatile conformance adapter
- [`packages/adapter-job-sqlite`](./packages/adapter-job-sqlite): disabled metadata-only SQLite transaction/restart prototype
- [`packages/ui`](./packages/ui): accessible React primitives and semantic design tokens
- [`services/inference-python`](./services/inference-python): Python contract boundary and generated Pydantic models
- `fixtures/contracts`: synthetic valid and invalid cross-language examples
- `tooling`: deterministic generation and dependency-boundary checks
