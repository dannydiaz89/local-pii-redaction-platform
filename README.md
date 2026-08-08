# Local PII Redaction Platform

This repository contains a local-first PII redaction platform. It includes the contract foundation
and an initial development TXT/Markdown CLI slice with deterministic scanning, typed-label
replacement, and reopen/rescan verification.

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
```

No runtime component in this milestone makes a network request or accepts real PII fixtures.

## Try the CLI

The project currently runs as a local CLI, not a background HTTP service.

```sh
pnpm build
pnpm pii-redact capabilities --json
pnpm pii-redact inspect ./sample.txt
pnpm pii-redact scan ./sample.txt --json
pnpm pii-redact redact ./sample.txt --output ./sample.redacted.txt
pnpm pii-redact verify ./sample.redacted.txt --json
```

`redact` never overwrites its input or an existing output. It writes to a private staging file,
reopens the staged UTF-8 artifact, rescans it, and publishes the requested path only when the
`text-rescan-v1` profile passes. Machine reports contain entity types and offsets, not matched
values.

Exit codes are `0` for success, `2` for usage, `3` for processing errors, `4` for failed
verification, `5` for unresolved scan conflicts, and `6` for output collisions.

## Current limitations

- Only UTF-8 `.txt`, `.md`, and `.markdown` regular files are accepted; symbolic links are rejected.
- Detection is rules-only. It currently covers email, general phone shapes, structurally valid US
  SSNs, Luhn-valid payment cards, IPv4/IPv6, and explicit API-key/access-token/password assignments.
- The verification profile is a deterministic residual rescan, not a claim that all PII classes or
  contextual entities were detected.
- There is no durable job store, contextual model, HTTP API, or review UI yet.
- This is development software and must not be treated as a compliance certification or a guarantee
  that a document contains no sensitive data.

## Repository layout

- `packages/contracts`: canonical schemas, OpenAPI, generated TypeScript, runtime validation
- `packages/domain`: pure identifiers, errors, spans, and job state transitions
- `packages/detectors`: bounded deterministic evidence providers
- `packages/span-resolution`: deterministic overlap handling and explicit conflicts
- `packages/redaction`: immutable typed-label plans and application
- `packages/adapter-text`: strict UTF-8 reading and staged, non-overwriting writes
- `packages/verification`: privacy-minimized deterministic residual verification
- `packages/core`: use-case and provider/adapter ports
- `services/inference-python`: narrow Python contract boundary and generated Pydantic models
- `fixtures/contracts`: synthetic valid and invalid cross-language examples
- `tooling`: deterministic generation and dependency-boundary checks
