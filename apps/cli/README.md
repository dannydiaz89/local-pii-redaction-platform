# `@local-pii/cli`

Command-line interface for the local rules-only TXT/Markdown/JSON/CSV profile, the strict
experimental DOCX inspect/scan surface, and the explicit experimental Ollama scan profile.

## Responsibilities

- Implements `inspect`, `scan`, bounded rules-only `batch scan` and `batch redact`, `redact`, `verify`, `capabilities`,
  policy inspection, and bounded staged-artifact cleanup commands.
- Converts canonical application results and safe errors into stable human or JSON output and
  documented exit codes. Exit zero includes an explicitly accepted conflict-free partial batch;
  callers must still inspect its `PARTIAL` manifest.
- Owns CLI argument validation, process-signal handling, and command-specific policy binding.
- Loads an optional bounded, strict JSON `--policy-file` for scan/redact. Version 2 policies support
  exact JSON Pointer and CSV index/header classification; selectors and file paths are omitted from
  reports. There are no YAML, include, environment, executable, or network policy sources.
- Keeps Ollama opt-in, loopback-only, experimental, and scan-only.
- Recursively scans a deterministic, contained TXT/Markdown/JSON/CSV selection with bounded
  include/exclude globs, a deterministic non-backtracking matcher with an explicit work budget,
  conservative symlink rejection, a total byte/time budget, and an aggregate
  privacy-safe manifest. The default remains strict: any selected-file failure returns nonzero.
  Explicit `--allow-partial` returns success for a still-visible partial manifest only when at least
  one file completed and no completed result needs review; an all-failed batch remains nonzero. The
  canonical report binds that choice as `completionPolicy`, including on complete and failed
  attempts. The deadline is cooperative; hard isolation of synchronous parsers remains future sandbox work.
  `batch redact` adds strict rules-only verified publication to an explicit, separate, pre-existing
  output root. It preflights every deterministic relative target before processing, never
  overwrites, rejects `--allow-partial`, and returns nonzero for partial publication while exposing
  only aggregate counts and safe error codes. Verified outputs published before a later safe
  failure remain present; resumability and rollback are not claimed.
- Selects the native JSON adapter for `.json`; keys remain outside detection and only string values
  may be transformed.
- Selects the native CSV adapter for `.csv`; an explicit v2 policy may select its delimiter and
  header behavior, while transformations remain inside their originating cells.
- Selects the strict DOCX adapter for `.docx` inspection and rules-only scanning. DOCX redaction,
  verification, and Ollama are rejected before staging or provider access.
- Selects the strict synthetic-only PDF adapter for `.pdf` inspection. PDF scanning, redaction,
  verification, preview, OCR, and Ollama are rejected before processing or provider access.

Reusable application composition lives in `@local-pii/profile-local`; this package is the terminal
adapter and must not become a second copy of the core processing workflow.

## Development

```sh
pnpm --filter @local-pii/cli build
pnpm exec vitest run apps/cli/test
pnpm --silent cli -- capabilities --json
```

See the [root README](../../README.md) for complete commands, guarantees, and limitations.
