# `local-pii-inference`

Python-side contract boundary for future contextual inference services.

## Responsibilities

- Contains Pydantic models generated from the canonical JSON Schemas.
- Validates the same cross-language fixture corpus as the TypeScript implementation.
- Provides deterministic model-generation and contract-check scripts.

## Current scope

This directory is not a running inference server and does not load or execute a model. The canonical
schemas in `packages/contracts` remain the source of truth; generated Python models must not be
edited by hand.

## Development

From the repository root:

```sh
.venv/bin/ruff check services/inference-python
.venv/bin/pytest services/inference-python
.venv/bin/python services/inference-python/scripts/check_contracts.py
```

Use `pnpm contracts:check` to run the complete cross-language drift and fixture gate.
