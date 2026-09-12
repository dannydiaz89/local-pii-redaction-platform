# Local PII Redaction Platform

This repository contains a local-first PII redaction platform. It includes the contract foundation
and development TXT/Markdown, JSON, and CSV CLI slices with deterministic scanning, typed-label
replacement, native reopen/rescan verification, an experimental strict DOCX slice that now scans and
redacts a narrow qualified carrier surface, and an explicitly experimental local Ollama scan path.

Copyright (C) 2026 [dannydiaz89](https://github.com/dannydiaz89). The project is licensed under
`AGPL-3.0-only`; see `LICENSE` and `ATTRIBUTION.md`.

## What it does

Every block below is verbatim output from a real run against the synthetic corpus in
`sample-data/`. Nothing is abridged except file paths.

**Scan a file.** The report is deliberately value-free — counts and spans, never the matched text —
and nothing is written to disk.

```console
$ pii-redact scan notes.txt
Found 16 resolved detection(s) and 0 conflict(s).
```

**Redact to a separate file.** The input is never modified. The output is staged privately,
reopened, rescanned, and only then published: publication is gated on verification rather than on
the writer reporting success.

```console
$ pii-redact redact notes.txt --output notes.redacted.txt --policy development-labels
Wrote attested output under development-labels 0.1.0 with 16 replacement(s).
```

```diff
- Résumé owner 👩🏽‍💻: alpha@example.test.
- Escalation (after hours): ops.team+night@example.invalid;
- Primary phone: +1 (202) 555-0147.
- International callback: +44 7700 900123;
- Synthetic tax identifier: 123-45-6789.
- Test payment card (spaced): 4242 4242 4242 4242.
+ Résumé owner 👩🏽‍💻: [EMAIL_1].
+ Escalation (after hours): [EMAIL_2];
+ Primary phone: [PHONE_1].
+ International callback: [PHONE_2];
+ Synthetic tax identifier: [SSN_1].
+ Test payment card (spaced): [CREDIT_CARD_1].
```

**Verify it independently.** A separate command re-reads the published file and rescans it from
scratch, with no knowledge of the plan that produced it.

```console
$ pii-redact verify notes.redacted.txt
Residual scan passed: no deterministic residuals were found in the supplied artifact.
```

### The same flow on a Word document

DOCX is the hard case. Text is fragmented across runs, and a value can hide in a header, a comment,
an author attribute, a hyperlink target, or text the author "deleted" with track changes on.
Redaction is authorised only behind its own verification profile, which reopens the staged package
with an independent parser.

```console
$ pii-redact scan onboarding-record.docx --json
byEntity: { EMAIL: 1, PHONE: 2, IP_ADDRESS: 1 }

$ pii-redact redact onboarding-record.docx --output onboarding-record.redacted.docx \
    --policy development-labels --json
outcome        VERIFIED
verification   PASS     profile docx-redact-v1 0.2.0
checks         STRUCTURE, NATIVE_SURFACE, DETERMINISTIC_RESCAN, ACTION_RECONCILIATION
reconciliation expected 4 · applied 4 · missing 0 · unexpected 0 · duplicate 0

$ pii-redact scan onboarding-record.redacted.docx --json
byEntity: {}   detections: 0
```

The paragraph text before and after, read straight out of `word/document.xml`:

```diff
- Escalation contact: ops.team+night@example.invalid
- Primary desk line: +1 (202) 555-0147
- Secondary line: (415) 555-0136 and audit endpoint 192.0.2.10
+ Escalation contact: [EMAIL_1]
+ Primary desk line: [PHONE_1]
+ Secondary line: [PHONE_2] and audit endpoint [IP_ADDRESS_1]
  Engagement window 2019-2023, ticket 1234567, ZIP 12345-6789 stay untouched.
```

That last line matters: a year range, a ticket number, and a ZIP+4 all look like telephone numbers
to a rule that accepts any run of digits, and were once reported as such. They now survive, while a
parenthesised area code is replaced including its opening bracket.

### What refusal looks like

A policy the current build cannot satisfy is refused before the file is read, and names every
unmet requirement rather than quietly degrading.

```console
$ pii-redact redact notes.txt --output out.txt --policy high-risk-disclosure
POLICY_UNSATISFIABLE: The selected policy cannot be satisfied by the available local capabilities.
# no output file is created
$ echo $?
3

$ pii-redact policies explain high-risk-disclosure
Satisfiable: no
FORMAT_QUALIFICATION_SUFFICIENT: unavailable          # no component is QUALIFIED
ENTITY_DETECTOR_REQUIREMENTS_SATISFIED: unavailable   # PERSON needs a MODEL detector kind
TRANSFORMATION_REQUIREMENTS_SATISFIED: unavailable    # SSN needs irreversible REDACT
VERIFICATION_PROFILE_AVAILABLE: unavailable           # high-risk-v1 is deliberately unbuilt
```

### What these runs do not prove

- The corpus is synthetic. The same flow run against a real Word résumé found six detections and
  rescanned the published output clean, but that evidence is not reproducible from this repository.
- DOCX assurance is declared `STRUCTURAL_REPLACE`, not `NATIVE_REDACTION`: no Office renderer has
  confirmed the published package opens cleanly.
- Rules-only detection finds no names or addresses. Contextual detection exists, is opt-in and
  experimental, and no model is qualified.
- A clean rescan proves the deterministic detectors find nothing on a second pass. It does not
  prove the document is free of every kind of personal data.

## Prerequisites

- Node.js 24 or newer
- pnpm 10
- Python 3.12 or newer
- [Ollama](https://ollama.com/download) — required for the opt-in `--engine ollama` contextual
  path, and only for that path. The rules-only default, the `--engine inference` path, and every
  gate in `pnpm check` all run without it.

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

The commands below are a reference list rather than a tour; see [What it does](#what-it-does) for
the same flow with its output.

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
## Recovery, cancellation, and exit codes

`cleanup-stages` is a bounded recovery tool for a redaction that was interrupted. It is a dry run
unless `--apply` is given, considers only private stages older than 24 hours that match the exact
selected output, and reports counts without filenames or paths. Run it only in a trusted directory:
the generated UUID filename narrows the candidates but is not proof that the application owns a file.

```sh
pnpm --silent pii-redact cleanup-stages \
  --output ./test-output/sample.redacted.txt --apply --json
```

`SIGINT` and `SIGTERM` request cooperative cancellation. The CLI waits for in-flight cleanup and
returns the canonical `OPERATION_CANCELLED` error without publishing an unverified output.

| exit | meaning |
|---|---|
| `0` | success, or an explicitly accepted conflict-free partial batch |
| `2` | usage error |
| `3` | processing failure or incomplete recovery |
| `4` | verification failed |
| `5` | unresolved scan conflicts, or the policy requires review |
| `6` | output collision |
| `130` / `143` | cancelled by `SIGINT` / `SIGTERM` |

## Experimental contextual engines

Detection is rules-only by default. Two opt-in engines add contextual detection, both requiring
`--allow-experimental`, both bounded to TXT/Markdown, and both failing closed rather than silently
falling back. Neither is qualified.

The Ollama path needs a running daemon and an already-installed model; the application never
starts the daemon and never pulls a model itself, because both are network operations and this
repository does not make them on your behalf. Install [Ollama](https://ollama.com/download), then:

```sh
ollama serve            # unless it is already running as a service
ollama pull phi4-mini:3.8b
```

Any Ollama model may be named. `phi4-mini:3.8b` and `gemma3:4b` are the two the harness under
`tooling/evaluate-ollama.ts` has been run against; neither is qualified. A model that is not
installed is refused rather than pulled, and the refusal says which of the two setup steps is
missing: `The requested local model is not installed.` against `The local model runtime is not
reachable.` Both carry the canonical `MODEL_UNAVAILABLE` code with a distinguishing
`details.reason` in JSON output.

```sh
# a locally installed Ollama model
pnpm --silent pii-redact scan ./sample-data/contextual/development/contextual-development-positive.txt \
  --engine ollama --model phi4-mini:3.8b --allow-experimental --json

# the local Python inference service, over a stdio subprocess with a digest-pinned bundle
pnpm --silent pii-redact scan ./sample-data/contextual/development/contextual-development-positive.txt \
  --engine inference --bundle ./fixtures/models/synthetic-lexicon-v1 \
  --python ./.venv/bin/python --allow-experimental --json

# the local web review application on the same engine, pinned once per server session
pnpm start:local -- --engine ollama --model phi4-mini:3.8b --allow-experimental
```

Model evidence carries a deliberately uncalibrated confidence that sits below the bundled policies'
threshold, so every model span is held for review rather than redacted automatically. On the command
line, `--accept-model-evidence` records an explicit operator acceptance for each such span and binds
it into the plan digest; in the browser, the review workflow is the acceptance path. `batch scan` and
`batch redact` accept the same engines with a text-only default selection.

A hybrid redaction is verified under `text-rescan-v1` 0.2.0, which adds a `CONTEXTUAL_RESCAN` check:
the same digest-pinned model is asked to read the reopened output again, and anything it anchors
there blocks publication. If the model cannot be reached during that rescan the attestation is
`INCOMPLETE` and nothing is published.

## Applications and packages

Each application and package documents its own responsibilities and boundary; those READMEs are the
detail, not this file.

- [`apps/cli`](./apps/cli) — the terminal interface, and the most complete surface
- [`apps/api`](./apps/api) — loopback-only HTTP composition root and launcher lifecycle
- [`apps/web`](./apps/web) — the accessible, localized React review shell
- [`packages/adapter-text`](./packages/adapter-text), [`-json`](./packages/adapter-json),
  [`-csv`](./packages/adapter-csv), [`-docx`](./packages/adapter-docx),
  [`-pdf`](./packages/adapter-pdf) — per-format extraction, source maps, and writers
- [`packages/verification`](./packages/verification) — residual verification and attestations
- [`packages/policy`](./packages/policy) — policy compilation and capability evaluation

## Current limitations

This is development software. It is not a compliance certification, and a clean result is not a
guarantee that a document contains no sensitive data.

- **Detection is rules-only by default**, covering email, general phone shapes, structurally valid
  US SSNs, Luhn-valid payment cards, IPv4/IPv6, and explicit API-key/token/password assignments. It
  finds no names or addresses without an experimental contextual engine, and no model is qualified.
- **Contextual engines are unqualified.** On the 30-document synthetic harness `gemma3:4b` reaches
  per-class F1 between 0.63 and 0.97 and `phi4-mini:3.8b` between 0.68 and 0.87; both evaluated
  models produce false positives, and a document instructing the model to report only some entity
  types still suppresses the others. Treat any document that may carry attacker-controlled text as
  outside this path's guarantees.
- **The contextual set stays disjoint from the rules set, and a model cannot second-opinion a rules
  finding.** Asked only for the six contextual types, `gemma3:4b` shoehorns rather than declines:
  54 of 492 returned spans land exactly on a rules-covered value, an email becoming `PERSON` and a
  payment card or SSN becoming `ACCOUNT_ID`. Letting it return the true labels was measured and not
  shipped. It removed most of the shoehorning but cost recall on the types only a model can supply
  (`ORGANIZATION` 0.92 to 0.79, `ADDRESS` 0.94 to 0.83), recovered only 54 of the 75 rules-covered
  spans the rules recover exactly, and managed 0.25 recall on `SSN` in both models. It also made a
  model label able to displace a deterministic one: span resolution ranks `EMAIL`, `SSN` and
  `CREDIT_CARD` above every contextual type, so a wrong rules-covered label silently replaces a
  checksum or regex finding with an uncalibrated 0.5 guess and raises no conflict, where a wrong
  contextual label is harmlessly dropped.
- **Verification is a deterministic residual rescan**, not a claim that every class of personal data
  was detected. The contextual rescan inherits the model's recall limits.
- **Format coverage is uneven.** TXT/Markdown, JSON, and CSV support the full inspect/scan/redact/
  verify cycle. DOCX redaction is authorised only over a narrow qualified carrier surface and is
  declared `STRUCTURAL_REPLACE`, not renderer-confirmed. PDF is inspect-only and synthetic-only.
- **Nothing is durable.** Jobs, artifacts, review decisions, and verified outputs live only for the
  current process; there is no retained store, resume, or report history.
- **Cleanup is cooperative.** It cannot run after `SIGKILL`, a crash, or power loss, and unlinking a
  stage is not secure erasure — copies may remain in journals, snapshots, backups, or swap.
- **Processing is whole-file, not streaming.** Bounds are enforced, but reference-hardware and
  cross-platform resource qualification remain open.
- **The browser launcher supports macOS and Linux.** Windows launch, packaged installation, and
  defence against a local process racing the first one-shot handoff remain open.


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
