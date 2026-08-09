# Local PII Redaction Platform

This repository contains a local-first PII redaction platform. It includes the contract foundation
and an initial development TXT/Markdown CLI slice with deterministic scanning, typed-label
replacement, reopen/rescan verification, and an explicitly experimental local Ollama scan path.

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
```

The default runtime makes no network request and the repository accepts only synthetic fixtures.
The opt-in Ollama path talks only to a numeric loopback address on the same machine.
`pnpm ephemeral:check` builds and spawns the default rules-only CLI with Node filesystem permissions
and an injected network/DNS guard. It proves read-only commands retain no files and successful
redaction adds only the requested verified output inside a disposable workspace. This is
application-level evidence; OS syscall tracing and network-namespace packaging tests remain later
release gates.

## Try the CLI

The project currently runs as a local CLI, not a background HTTP service.

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
pnpm --silent pii-redact cleanup-stages \
  --output ./test-output/sample.redacted.txt --json
```

The tracked `test-output/` directory is a local workspace for generated artifacts and JSON reports;
everything inside it except its `.gitignore` is ignored by Git. Delete or rename an existing output
before rerunning a command because the CLI intentionally never overwrites output files.
`redact` always requires an explicit `--output`; it never silently chooses a destination beside the
input.

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

`policies explain` is read-only: it compiles a bundled example and compares its requirements with
the current rules-only text capability without opening a document or contacting Ollama. The
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

`SIGINT` and `SIGTERM` request cooperative cancellation. The CLI waits for in-flight cleanup and
returns the canonical `OPERATION_CANCELLED` error without publishing an unverified output. Signal
exit codes are `130` for `SIGINT` and `143` for `SIGTERM`.

Other exit codes are `0` for success, `2` for usage, `3` for processing or incomplete recovery,
`4` for failed verification, `5` for unresolved scan conflicts or policy review, and `6` for
output collisions.

## Current limitations

- Only UTF-8 `.txt`, `.md`, and `.markdown` regular files are accepted; symbolic links are rejected.
- Rules-only remains the default. It covers email, general phone shapes, structurally valid US SSNs,
  Luhn-valid payment cards, IPv4/IPv6, and explicit API-key/access-token/password assignments.
- The opt-in Ollama hybrid scan is experimental and unqualified. Its contextual results can be
  incomplete or have incorrect spans; `phi4-mini` previously produced zero exact matches on the
  small frozen harness. It is useful for testing integration, not for making safety claims.
- The verification profile is a deterministic residual rescan, not a claim that all PII classes or
  contextual entities were detected.
- Cooperative cleanup cannot run after `SIGKILL`, a process or host crash, power loss, or some
  filesystem failures. Orphan-stage unlinking is not secure erasure and does not remove copies from
  filesystem journals, snapshots, backups, swap, or provider logs. Recovery is an explicit
  operator action in a trusted directory because stage-like filenames are not ownership proofs.
- There is no durable job store, qualified contextual model, HTTP API, or review UI yet.
- This is development software and must not be treated as a compliance certification or a guarantee
  that a document contains no sensitive data.

## Repository layout

- `packages/contracts`: canonical schemas, OpenAPI, generated TypeScript, runtime validation
- `packages/domain`: pure identifiers, errors, spans, and job state transitions
- `packages/policy`: immutable bundled policy validation, compilation, and capability explanations
- `packages/detectors`: bounded deterministic evidence providers
- `packages/span-resolution`: deterministic overlap handling and explicit conflicts
- `packages/redaction`: immutable typed-label plans and application
- `packages/adapter-text`: strict UTF-8 reading and staged, non-overwriting writes
- `packages/verification`: privacy-minimized deterministic residual verification
- `packages/core`: use-case and provider/adapter ports
- `services/inference-python`: narrow Python contract boundary and generated Pydantic models
- `fixtures/contracts`: synthetic valid and invalid cross-language examples
- `tooling`: deterministic generation and dependency-boundary checks
