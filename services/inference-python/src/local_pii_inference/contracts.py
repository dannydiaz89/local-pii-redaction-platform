from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


def _repository_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _load_schemas() -> tuple[dict[str, Any], ...]:
    root = _repository_root() / "packages" / "contracts" / "schemas"
    return tuple(
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(root.rglob("*.schema.json"))
    )


_SCHEMAS = _load_schemas()
_SCHEMA_BY_ID = {schema["$id"]: schema for schema in _SCHEMAS}
_REGISTRY = Registry().with_resources(
    (schema_id, Resource.from_contents(schema))
    for schema_id, schema in _SCHEMA_BY_ID.items()
)


def validate_contract(schema_id: str, value: object) -> None:
    """Validate a value against a canonical contract or raise a schema validation error."""
    try:
        schema = _SCHEMA_BY_ID[schema_id]
    except KeyError as error:
        raise ValueError(f"Unknown contract schema: {schema_id}") from error
    Draft202012Validator(schema, registry=_REGISTRY, format_checker=FormatChecker()).validate(value)
