from __future__ import annotations

import json
import re
from calendar import monthrange
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
_FORMAT_CHECKER = FormatChecker()
_CANONICAL_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_RFC3339_DATE_TIME = re.compile(
    r"^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])[Tt]"
    r"(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?"
    r"(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$"
)


@_FORMAT_CHECKER.checks("uuid")
def _is_canonical_uuid(value: object) -> bool:
    return isinstance(value, str) and _CANONICAL_UUID.fullmatch(value) is not None


@_FORMAT_CHECKER.checks("date-time")
def _is_rfc3339_date_time(value: object) -> bool:
    if not isinstance(value, str):
        return False
    match = _RFC3339_DATE_TIME.fullmatch(value)
    if match is None:
        return False
    year, month, day = (int(part) for part in match.groups())
    return day <= monthrange(year, month)[1]


def validate_contract(schema_id: str, value: object) -> None:
    """Validate a value against a canonical contract or raise a schema validation error."""
    try:
        schema = _SCHEMA_BY_ID[schema_id]
    except KeyError as error:
        raise ValueError(f"Unknown contract schema: {schema_id}") from error
    Draft202012Validator(schema, registry=_REGISTRY, format_checker=_FORMAT_CHECKER).validate(value)
