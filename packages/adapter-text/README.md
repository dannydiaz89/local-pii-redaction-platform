# `@local-pii/adapter-text`

Filesystem adapter for bounded TXT and Markdown input and verified, non-overwriting output.

## Responsibilities

- Opens regular files safely, enforces byte limits, and decodes strict UTF-8.
- Preserves source identity and detects changes across a processing session.
- Creates private same-directory stages, verifies staged bytes, publishes with a hard link, and
  cleans up the private stage where possible.
- Produces and validates canonical writer receipts.
- Inventories and reconciles narrowly scoped orphaned stages for the CLI recovery command.

## Boundary

This package owns filesystem mechanics, not detection, policy decisions, redaction semantics, or
workflow orchestration. It currently materializes bounded whole text artifacts and is not a
streaming adapter.

## Public entry point

Import from `@local-pii/adapter-text`. The primary composition function is
`createLocalTextArtifactSession`.

```sh
pnpm --filter @local-pii/adapter-text build
pnpm exec vitest run packages/adapter-text/test
```
