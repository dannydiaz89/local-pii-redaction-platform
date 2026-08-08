from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema.exceptions import ValidationError
from local_pii_inference.contracts import validate_contract
from local_pii_inference.generated.detection_detect_request import InferenceDetectRequest


def repository_root() -> Path:
    return Path(__file__).resolve().parents[3]


def test_valid_detection_contract() -> None:
    path = repository_root() / "fixtures" / "contracts" / "valid" / "detection-email.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    validate_contract("https://local-pii.dev/schemas/detection/detection/1.0.0", value)


def test_detection_contract_rejects_matched_text() -> None:
    path = (
        repository_root()
        / "fixtures"
        / "contracts"
        / "invalid"
        / "detection-unknown-field.json"
    )
    value = json.loads(path.read_text(encoding="utf-8"))
    with pytest.raises(ValidationError):
        validate_contract("https://local-pii.dev/schemas/detection/detection/1.0.0", value)


def test_generated_pydantic_model_is_strict() -> None:
    value = {
        "schemaVersion": "1.0.0",
        "requestId": "d9b8a330-8d9a-4f6f-8f11-5b2f10e53967",
        "chunks": [{"id": "chunk-1", "text": "Synthetic Person", "absoluteStart": 0}],
        "entityTypes": ["PERSON"],
        "minimumConfidence": 0.55,
        "options": {"maxDetectionsPerChunk": 200},
    }
    model = InferenceDetectRequest.model_validate(value)
    assert model.chunks[0].absoluteStart == 0

    value["unexpected"] = True
    with pytest.raises(ValueError):
        InferenceDetectRequest.model_validate(value)

    value.pop("unexpected")
    value["chunks"][0]["absoluteStart"] = "0"
    with pytest.raises(ValueError):
        InferenceDetectRequest.model_validate(value)
