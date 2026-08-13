# `@local-pii/profile-local`

Reusable composition root for the platform's current local file-processing profiles.

## Responsibilities

- Assembles the rules-only detector, verifier, capabilities, and core application.
- Publishes the current rules-only TXT/Markdown/JSON/CSV CLI manifest with the experimental strict
  DOCX/PDF surfaces, a bounded TXT/Markdown/JSON/CSV process-local API manifest, and the experimental text-only
  Ollama hybrid manifest.
- Creates the explicitly requested Ollama hybrid application after provider preparation.
- Supplies capability requirements shared by the CLI and local API.
- Projects a bounded catalog of pinned policy metadata for the local API, including a separately
  versioned and digested 8 MiB process-local policy variant.

## Boundary

This package wires existing ports and adapters together. It contains no command parsing, HTTP
handling, browser logic, or durable state. JSON and CSV are rules-only in the CLI and process-local API
slice. DOCX is rules-only, CLI-only, experimental, and limited to inspect/scan. PDF is CLI-only,
experimental, extraction-only, and limited to probe/inspect even though its closed v5 profile maps
the narrow accepted Info/XMP metadata values. Ollama remains
experimental, loopback-only, text-only, and scan-only.

There is no package-local test directory yet; its compositions are exercised through CLI, API, core,
and provider integration tests.

```sh
pnpm --filter @local-pii/profile-local build
pnpm exec vitest run apps/cli/test apps/api/test packages/core/test
```
