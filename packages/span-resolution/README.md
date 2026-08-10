# `@local-pii/span-resolution`

Deterministic resolution of overlapping and duplicate detection evidence.

## Responsibilities

- Validates evidence spans against canonical text length.
- Groups supporting evidence for equivalent spans.
- Applies deterministic precedence when spans overlap.
- Returns accepted spans and explicit conflicts without mutating evidence.

## Boundary

Resolution decides which evidence spans can coexist. It does not decide policy actions, classify
text, redact content, or suppress unresolved conflicts from callers.

## Public entry point

Use `resolveEvidence` from `@local-pii/span-resolution`.

```sh
pnpm --filter @local-pii/span-resolution build
pnpm exec vitest run packages/span-resolution/test
```
