from __future__ import annotations

import json
from pathlib import Path

from jsonschema.exceptions import ValidationError
from local_pii_inference.contracts import validate_contract


def repository_root() -> Path:
    return Path(__file__).resolve().parents[3]


def main() -> None:
    corpus_root = repository_root() / "fixtures" / "contracts"
    manifest = json.loads((corpus_root / "manifest.json").read_text(encoding="utf-8"))
    for case in manifest["cases"]:
        value = json.loads((corpus_root / case["file"]).read_text(encoding="utf-8"))
        try:
            validate_contract(case["schemaId"], value)
            actual = True
        except ValidationError:
            actual = False
        if actual != case["valid"]:
            raise AssertionError(
                f"{case['file']}: expected valid={case['valid']}, got {actual}"
            )
    print(f"Python validated {len(manifest['cases'])} cross-language fixtures.")


if __name__ == "__main__":
    main()
