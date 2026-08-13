from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


def repository_root() -> Path:
    return Path(__file__).resolve().parents[3]


def normalize_references(
    value: Any,
    current_path: Path,
    id_to_path: dict[str, Path],
    id_to_schema: dict[str, dict[str, Any]],
) -> Any:
    if isinstance(value, list):
        return [
            normalize_references(item, current_path, id_to_path, id_to_schema)
            for item in value
        ]
    if not isinstance(value, dict):
        return value

    result: dict[str, Any] = {}
    for key, child in value.items():
        if key == "$ref" and isinstance(child, str) and child.startswith("https://local-pii.dev/"):
            schema_id, separator, fragment = child.partition("#")
            try:
                target = id_to_path[schema_id]
            except KeyError as error:
                raise ValueError(f"Unresolved schema reference: {child}") from error
            # datamodel-code-generator cannot emit a single file for this
            # schema when its discriminated union is a whole-schema remote
            # reference. Inline this small, leaf schema only. Other whole-
            # schema references may contain local #/$defs references whose
            # meaning would change if they were copied into the parent.
            if (
                separator == ""
                and schema_id in {
                    "https://local-pii.dev/schemas/common/native-location/1.0.0",
                    "https://local-pii.dev/schemas/common/native-location/2.0.0",
                    "https://local-pii.dev/schemas/common/native-location/3.0.0",
                    "https://local-pii.dev/schemas/common/native-location/4.0.0",
                }
            ):
                target_schema = {
                    nested_key: nested_value
                    for nested_key, nested_value in id_to_schema[schema_id].items()
                    if nested_key not in {"$schema", "$id", "examples", "schemaVersion"}
                }
                result.update(normalize_references(
                    target_schema,
                    target,
                    id_to_path,
                    id_to_schema,
                ))
            else:
                relative_path = Path(os.path.relpath(target, current_path.parent)).as_posix()
                result[key] = f"{relative_path}{separator}{fragment}"
        else:
            result[key] = normalize_references(child, current_path, id_to_path, id_to_schema)
    return result


def generate(output: Path) -> None:
    root = repository_root()
    schema_root = root / "packages" / "contracts" / "schemas"
    schema_paths = sorted(schema_root.rglob("*.schema.json"))
    schemas = {path: json.loads(path.read_text(encoding="utf-8")) for path in schema_paths}

    with tempfile.TemporaryDirectory(prefix="local-pii-schemas-") as temp_name:
        normalized_root = Path(temp_name)
        id_to_path = {
            schema["$id"]: normalized_root / path.relative_to(schema_root)
            for path, schema in schemas.items()
        }
        id_to_schema = {schema["$id"]: schema for schema in schemas.values()}
        for path, schema in schemas.items():
            normalized_path = normalized_root / path.relative_to(schema_root)
            normalized_path.parent.mkdir(parents=True, exist_ok=True)
            normalized = normalize_references(schema, normalized_path, id_to_path, id_to_schema)
            normalized_path.write_text(json.dumps(normalized, indent=2) + "\n", encoding="utf-8")

        if output.exists():
            shutil.rmtree(output)
        output.mkdir(parents=True)
        (output / "__init__.py").write_text(
            '"""Generated Pydantic v2 models. Do not edit."""\n', encoding="utf-8"
        )

        for path in schema_paths:
            relative = path.relative_to(schema_root)
            module_name = "_".join(relative.parts).removesuffix(".schema.json").replace("-", "_")
            input_path = normalized_root / relative
            output_path = output / f"{module_name}.py"
            command = [
                sys.executable,
                "-m",
                "datamodel_code_generator",
                "--input",
                str(input_path),
                "--input-file-type",
                "jsonschema",
                "--output",
                str(output_path),
                "--output-model-type",
                "pydantic_v2.BaseModel",
                "--target-python-version",
                "3.12",
                "--use-standard-collections",
                "--use-union-operator",
                "--disable-timestamp",
                "--strict-nullable",
                "--strict-refs",
                "--strict-types",
                "str",
                "bytes",
                "int",
                "float",
                "bool",
                "--use-title-as-name",
                "--allow-remote-refs",
                "--formatters",
                "builtin",
            ]
            subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=repository_root()
        / "services"
        / "inference-python"
        / "src"
        / "local_pii_inference"
        / "generated",
    )
    arguments = parser.parse_args()
    generate(arguments.output.resolve())


if __name__ == "__main__":
    main()
