# `local-pii-inference`

Python-side contract boundary for future contextual inference services.

## Responsibilities

- Contains Pydantic models generated from the canonical JSON Schemas.
- Validates the same cross-language fixture corpus as the TypeScript implementation.
- Provides deterministic model-generation and contract-check scripts.

## Current scope

The package now contains the transport-neutral inference service from the service design
(`service.py`), verified bundle loading (`bundle.py`), a span-runtime boundary (`runtime.py`), and
the local subprocess profile (`stdio.py`): length-prefixed JSON frames over stdio, chosen first
because it opens no socket and so keeps the default CLI's no-network posture. HTTP remains for the
container profile. The only runtime today is a deterministic synthetic lexicon built from the
DEVELOPMENT harness split; it exercises every contract path without a trained model and is
labelled `SYNTHETIC` in its manifest, capabilities, and responses. No model is downloaded or
substituted: readiness fails closed with `SUPPLY_CHAIN_INVALID` naming only the failing component.

```sh
.venv/bin/python -m local_pii_inference --bundle fixtures/models/synthetic-lexicon-v1
```

The canonical schemas in `packages/contracts` remain the source of truth; generated Python models
must not be edited by hand. Limit and bundle failures use the canonical error codes
(`INPUT_TOO_LARGE`, `DETECTION_LIMIT_EXCEEDED`, `SUPPLY_CHAIN_INVALID`) rather than the
`INFERENCE_LIMIT_EXCEEDED`/`MODEL_BUNDLE_INVALID` names used in the design document, which are
not in the error contract.

## Development

From the repository root:

```sh
.venv/bin/ruff check services/inference-python
.venv/bin/pytest services/inference-python
.venv/bin/python services/inference-python/scripts/check_contracts.py
```

Use `pnpm contracts:check` to run the complete cross-language drift and fixture gate.
