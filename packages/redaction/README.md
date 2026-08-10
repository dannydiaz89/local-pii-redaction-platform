# `@local-pii/redaction`

Pure compilation and application of typed-label redaction plans.

## Responsibilities

- Converts resolved spans and policy decisions into immutable, bound plans.
- Emits v2 plans that bind exact value-free review provenance and effective decisions when review
  is present; ordinary CLI redaction remains on the unchanged v1 plan contract.
- Computes and validates plan digests and component bindings.
- Applies non-overlapping actions in one pass using Unicode code-point offsets.
- Publishes the typed-label transformation capability descriptor.

## Boundary

This package transforms canonical text in memory. It does not detect evidence, choose policy rules,
read files, publish output, or verify residual PII. Filesystem publication belongs to adapters and
workflow sequencing belongs to core.

```sh
pnpm --filter @local-pii/redaction build
pnpm exec vitest run packages/redaction/test
```
