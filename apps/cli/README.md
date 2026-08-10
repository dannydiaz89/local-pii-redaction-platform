# `@local-pii/cli`

Command-line interface for the local rules-only TXT/Markdown/JSON profile and the explicit
experimental Ollama scan profile.

## Responsibilities

- Implements `inspect`, `scan`, `redact`, `verify`, `capabilities`, policy inspection, and bounded
  staged-artifact cleanup commands.
- Converts canonical application results and safe errors into stable human or JSON output and
  documented exit codes.
- Owns CLI argument validation, process-signal handling, and command-specific policy binding.
- Keeps Ollama opt-in, loopback-only, experimental, and scan-only.
- Selects the native JSON adapter for `.json`; keys remain outside detection and only string values
  may be transformed.

Reusable application composition lives in `@local-pii/profile-local`; this package is the terminal
adapter and must not become a second copy of the core processing workflow.

## Development

```sh
pnpm --filter @local-pii/cli build
pnpm exec vitest run apps/cli/test
pnpm --silent cli -- capabilities --json
```

See the [root README](../../README.md) for complete commands, guarantees, and limitations.
