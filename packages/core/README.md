# `@local-pii/core`

Application-layer orchestration for text inspection, detection, redaction, verification, and
capability preflight.

## Responsibilities

- Defines ports for capabilities, artifact sessions, detection, and verification.
- Coordinates cancellation-aware processing without depending on a CLI, HTTP server, filesystem,
  or model implementation.
- Applies capability and policy preflight before work begins.
- Applies exact review snapshots after deterministic resolution: accept, reject, and retype remain
  bound to the scan extraction revision and immutable plan digest.
- Validates version-matched typed native regions on structured artifacts and requires each
  detection to belong to exactly one region before resolution; v2 DOCX carriers cannot be passed
  through a v1 canonical wrapper.
- Routes exact structured-policy requests only through detectors that declare the structured port,
  failing before detection when the adapter source map or detector support is unavailable.
- Enforces the stage, reopen, verify, publish, and cleanup workflow for redaction.

## Boundary

Core owns use-case sequencing and invariants. Adapters implement I/O, detectors produce evidence,
policy decides actions, and presentation layers translate results into CLI or HTTP responses.

## Public entry point

Import `createTextProcessingApplication` and the port types from `@local-pii/core`.

```sh
pnpm --filter @local-pii/core build
pnpm exec vitest run packages/core/test
```
