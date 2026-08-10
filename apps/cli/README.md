# `@local-pii/cli`

Command-line interface for the local rules-only TXT/Markdown/JSON/CSV profile, the strict
experimental DOCX inspect/scan surface, and the explicit experimental Ollama scan profile.

## Responsibilities

- Implements `inspect`, `scan`, `redact`, `verify`, `capabilities`, policy inspection, and bounded
  staged-artifact cleanup commands.
- Converts canonical application results and safe errors into stable human or JSON output and
  documented exit codes.
- Owns CLI argument validation, process-signal handling, and command-specific policy binding.
- Keeps Ollama opt-in, loopback-only, experimental, and scan-only.
- Selects the native JSON adapter for `.json`; keys remain outside detection and only string values
  may be transformed.
- Selects the native CSV adapter for `.csv`; all cells are scanned and transformations remain
  inside their originating cells.
- Selects the strict DOCX adapter for `.docx` inspection and rules-only scanning. DOCX redaction,
  verification, and Ollama are rejected before staging or provider access.

Reusable application composition lives in `@local-pii/profile-local`; this package is the terminal
adapter and must not become a second copy of the core processing workflow.

## Development

```sh
pnpm --filter @local-pii/cli build
pnpm exec vitest run apps/cli/test
pnpm --silent cli -- capabilities --json
```

See the [root README](../../README.md) for complete commands, guarantees, and limitations.
