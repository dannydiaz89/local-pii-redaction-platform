# Sample data

This tracked directory contains synthetic fixtures for manual and automated testing. It must never
contain real personal data, credentials, or private documents.

- `input/sample.txt` exercises every detector in the initial rules-only bundle.
- `expected/sample.redacted.txt` is the expected typed-label output.

Try it with:

```sh
pnpm build
pnpm pii-redact scan ./sample-data/input/sample.txt --json
pnpm pii-redact verify ./sample-data/expected/sample.redacted.txt --json
```

Because expected outputs are tracked, write manual redaction results to a temporary or differently
named path to avoid the intentional output-collision protection.
