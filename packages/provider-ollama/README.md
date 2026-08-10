# `@local-pii/provider-ollama`

Experimental loopback-only Ollama contextual detection provider.

## Responsibilities

- Validates numeric-loopback endpoints and pinned model identity/digest.
- Builds the shared strict extraction prompt, schema, and fixed-seed request.
- Reads bounded UTF-8 responses with redirects disabled and cancellation/timeouts preserved.
- Strictly parses model-returned verbatim values and anchors unique exact matches to trusted local
  Unicode code-point offsets.
- Emits privacy-minimized evidence with an explicitly uncalibrated classification confidence.

## Boundary and limitations

The provider never pulls models and is used only with explicit consent for scan. Exact anchoring
proves source-location identity, not semantic correctness or completeness. Text necessarily enters
the local Ollama request/response path; Ollama and host logging, caching, swap, and diagnostics remain
outside the application's cleanup guarantee.

```sh
pnpm --filter @local-pii/provider-ollama build
pnpm exec vitest run packages/provider-ollama/test tooling/evaluate-ollama.test.ts
```
