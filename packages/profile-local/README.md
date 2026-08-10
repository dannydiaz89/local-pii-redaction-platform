# `@local-pii/profile-local`

Reusable composition root for the platform's current local TXT/Markdown processing profiles.

## Responsibilities

- Assembles the rules-only detector, verifier, capabilities, and core application.
- Publishes the current rules-only and experimental Ollama hybrid capability manifests.
- Creates the explicitly requested Ollama hybrid application after provider preparation.
- Supplies capability requirements shared by the CLI and local API.

## Boundary

This package wires existing ports and adapters together. It contains no command parsing, HTTP
handling, browser logic, or durable state. Ollama remains experimental, loopback-only, and scan-only.

There is no package-local test directory yet; its compositions are exercised through CLI, API, core,
and provider integration tests.

```sh
pnpm --filter @local-pii/profile-local build
pnpm exec vitest run apps/cli/test apps/api/test packages/core/test
```
