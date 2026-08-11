from __future__ import annotations

import json
import re
from calendar import monthrange
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker, ValidationError
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
_BATCH_SCAN_REPORT_SCHEMA_IDS = {
    "https://local-pii.dev/schemas/cli/batch-scan-report/1.0.0",
    "https://local-pii.dev/schemas/cli/batch-scan-report/2.0.0",
}


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


def _batch_scan_report_semantic_errors(value: object) -> tuple[str, ...]:
    report = value if isinstance(value, dict) else {}
    manifest_value = report.get("manifest")
    manifest = manifest_value if isinstance(manifest_value, dict) else {}
    by_entity_value = manifest.get("byEntity")
    by_entity = by_entity_value if isinstance(by_entity_value, dict) else {}
    failures_value = manifest.get("failuresByCode")
    failures = failures_value if isinstance(failures_value, dict) else {}
    errors: list[str] = []
    if manifest.get("selectedFileCount") != (
        manifest.get("processedFileCount", 0) + manifest.get("failedFileCount", 0)
    ):
        errors.append("selected file count does not reconcile")
    if manifest.get("processedInputBytes", 0) > manifest.get("totalInputBytes", 0):
        errors.append("processed bytes exceed selected bytes")
    if sum(by_entity.values()) != manifest.get("detectionCount"):
        errors.append("entity counts do not reconcile")
    if sum(failures.values()) != manifest.get("failedFileCount"):
        errors.append("failure counts do not reconcile")
    if manifest.get("complete") != (manifest.get("failedFileCount") == 0):
        errors.append("completion state does not reconcile")
    if manifest.get("selectedFileCount") == 0 and manifest.get("totalInputBytes") != 0:
        errors.append("empty selection reports selected bytes")
    if (
        manifest.get("processedFileCount") == 0
        and manifest.get("processedInputBytes") != 0
    ):
        errors.append("empty processing reports processed bytes")
    if manifest.get("processedFileCount") == 0 and manifest.get("detectionCount") != 0:
        errors.append("empty processing reports detections")
    if manifest.get("processedFileCount") == 0 and manifest.get("conflictCount") != 0:
        errors.append("empty processing reports conflicts")
    return tuple(errors)


def validate_contract(schema_id: str, value: object) -> None:
    """Validate a value against a canonical contract or raise a schema validation error."""
    try:
        schema = _SCHEMA_BY_ID[schema_id]
    except KeyError as error:
        raise ValueError(f"Unknown contract schema: {schema_id}") from error
    Draft202012Validator(schema, registry=_REGISTRY, format_checker=_FORMAT_CHECKER).validate(value)
    if schema_id in _BATCH_SCAN_REPORT_SCHEMA_IDS:
        semantic_errors = _batch_scan_report_semantic_errors(value)
        if semantic_errors:
            raise ValidationError("; ".join(semantic_errors))
