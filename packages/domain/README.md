# `@local-pii/domain`

Dependency-free domain vocabulary and invariants shared across the platform.

## Responsibilities

- Defines branded identifiers and SHA-256 digest parsing.
- Defines canonical entity types, detector provenance, and detection evidence.
- Provides privacy-safe typed errors and allow-listed error details.
- Defines Unicode code-point spans and safe slicing helpers.
- Defines legal job-state transitions.

## Boundary

The domain package contains no filesystem, network, framework, UI, or orchestration code. It is the
lowest-level runtime package and may not depend on another workspace package.

## Development

```sh
pnpm --filter @local-pii/domain build
pnpm exec vitest run packages/domain/test
```
