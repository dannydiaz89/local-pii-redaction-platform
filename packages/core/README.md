# `@local-pii/core`

Application-layer orchestration for text inspection, detection, redaction, verification, and
capability preflight.

## Responsibilities

- Defines ports for capabilities, artifact sessions, detection, and verification.
- Coordinates cancellation-aware processing without depending on a CLI, HTTP server, filesystem,
  or model implementation.
- Applies capability and policy preflight before work begins.
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
