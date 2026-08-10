# `@local-pii/profile-local`

Reusable composition root for the platform's current local file-processing profiles.

## Responsibilities

- Assembles the rules-only detector, verifier, capabilities, and core application.
- Publishes the current rules-only TXT/Markdown/JSON CLI manifest, the TXT/Markdown browser
  manifest, and the experimental text-only Ollama hybrid manifest.
- Creates the explicitly requested Ollama hybrid application after provider preparation.
- Supplies capability requirements shared by the CLI and local API.
- Projects a bounded catalog of pinned bundled-policy metadata for the local API.

## Boundary

This package wires existing ports and adapters together. It contains no command parsing, HTTP
handling, browser logic, or durable state. JSON is rules-only and CLI-only in the current slice;
Ollama remains experimental, loopback-only, text-only, and scan-only.

There is no package-local test directory yet; its compositions are exercised through CLI, API, core,
and provider integration tests.

```sh
pnpm --filter @local-pii/profile-local build
pnpm exec vitest run apps/cli/test apps/api/test packages/core/test
```
