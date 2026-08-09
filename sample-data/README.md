# Sample data

This tracked directory contains synthetic fixtures for manual and automated testing. It must never
contain real personal data, credentials, or private documents.

- `input/sample.txt` exercises every detector in the current rules-only bundle, including repeated
  entity types, punctuation boundaries, quoted secrets, Unicode context, and safe near-misses.
- `expected/sample.redacted.txt` is the expected typed-label output.
- `manifest.json` records generator provenance, digests, Unicode ground-truth spans, native text
  locations, ambiguity, and the expected policy outcome without copying planted values.
- `contextual/` contains frozen development, evaluation, and challenge inputs for contextual-model
  evaluator development. Its manifest includes exact Unicode code-point spans for `PERSON`,
  `ADDRESS`, `LOCATION`, `ORGANIZATION`, `DATE_OF_BIRTH`, and `ACCOUNT_ID`, along with provenance,
  seed, and content digests.

The contextual corpus is deliberately small and synthetic. It validates evaluator plumbing and
supports candidate comparisons, but it is not statistically sufficient evidence for a model or
detector release. Its `EVALUATION` split must not be used for prompt or threshold tuning.

The corpus is generated deterministically. Regenerate or verify it with:

```sh
pnpm fixtures:generate
pnpm fixtures:check
pnpm privacy:check
```

Try it with:

```sh
pnpm build
pnpm --silent pii-redact scan ./sample-data/input/sample.txt --json
pnpm --silent pii-redact redact ./sample-data/input/sample.txt \
  --output /tmp/sample.redacted.txt --json
diff -u ./sample-data/expected/sample.redacted.txt /tmp/sample.redacted.txt
pnpm --silent pii-redact verify ./sample-data/expected/sample.redacted.txt --json
```

Run the opt-in experimental hybrid scan against an already-installed Ollama model with:

```sh
pnpm --silent pii-redact scan ./sample-data/contextual/development/contextual-development-positive.txt \
  --engine ollama --model phi4-mini:3.8b --allow-experimental --json
```

This is a test surface, not a qualification result. The application never downloads models, never
falls back silently when the requested model fails, and currently exposes Ollama only for `scan`.
Run the same command without the engine/model flags to compare the unchanged rules-only default.

Because expected outputs are tracked, write manual redaction results to a temporary or differently
named path to avoid the intentional output-collision protection.

Compare already-installed Ollama models against the contextual harness with:

```sh
pnpm eval:ollama -- --model phi4-mini:3.8b --repeat 3
pnpm eval:ollama -- --model llama3.2:3b --repeat 3
pnpm eval:ollama -- --model qwen3.5:4b --repeat 3 --timeout-ms 120000
```

The evaluator connects only to an unauthenticated loopback IP, never pulls a model, and emits JSON
metrics without document text or matched values. Exact per-entity scores and repeatability are
useful for comparison, but this small harness is not release qualification. Ollama may use GPU
acceleration automatically; a run is not CPU-baseline evidence unless the server is separately
configured and verified for CPU-only execution.
