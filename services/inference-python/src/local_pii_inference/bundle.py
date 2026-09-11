"""Verified model bundle loading (INF-003, INF-004, INF-008).

A bundle is a directory holding ``manifest.json``, ``model.json``, and
``tokenizer.json``. Readiness fails closed when any asset is missing, corrupt, or
does not match the manifest digests. No asset is ever downloaded or substituted.
Error messages name a component, never a path or content.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from jsonschema.exceptions import ValidationError

from .contracts import validate_contract
from .runtime import SUPPORTED_RUNTIMES

MODEL_MANIFEST_SCHEMA_ID = "https://local-pii.dev/schemas/models/model-manifest/1.0.0"
PROTOCOL_VERSION = "1.0.0"
MAXIMUM_ASSET_BYTES = 256 * 1024 * 1024
MANIFEST_FILE = "manifest.json"
MODEL_FILE = "model.json"
TOKENIZER_FILE = "tokenizer.json"


class BundleError(Exception):
    """The bundle cannot be trusted; ``component`` is the only detail exposed."""

    code = "SUPPLY_CHAIN_INVALID"

    def __init__(self, component: str) -> None:
        super().__init__(f"The model bundle component is invalid: {component}.")
        self.component = component


@dataclass(frozen=True)
class VerifiedBundle:
    root: Path
    manifest: dict
    model_path: Path
    tokenizer_path: Path

    @property
    def model_identity(self) -> dict:
        return {
            "id": self.manifest["id"],
            "version": self.manifest["version"],
            "digest": self.manifest["modelDigest"],
            "runtime": self.manifest["runtime"],
        }


def _digest_file(path: Path, component: str) -> str:
    try:
        size = path.stat().st_size
        if size > MAXIMUM_ASSET_BYTES:
            raise BundleError(component)
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as error:
        raise BundleError(component) from error
    return f"sha256:{digest.hexdigest()}"


def load_bundle(root: Path) -> VerifiedBundle:
    root = root.resolve()
    manifest_path = root / MANIFEST_FILE
    try:
        raw = manifest_path.read_text(encoding="utf-8")
        manifest = json.loads(raw)
    except (OSError, ValueError) as error:
        raise BundleError("manifest") from error
    try:
        validate_contract(MODEL_MANIFEST_SCHEMA_ID, manifest)
    except ValidationError as error:
        raise BundleError("manifest") from error
    if PROTOCOL_VERSION not in manifest["protocolVersions"]:
        raise BundleError("protocol")
    if manifest["runtime"] not in SUPPORTED_RUNTIMES:
        raise BundleError("runtime")
    model_path = root / MODEL_FILE
    tokenizer_path = root / TOKENIZER_FILE
    if _digest_file(model_path, "model") != manifest["modelDigest"]:
        raise BundleError("model")
    if _digest_file(tokenizer_path, "tokenizer") != manifest["tokenizerDigest"]:
        raise BundleError("tokenizer")
    return VerifiedBundle(
        root=root, manifest=manifest, model_path=model_path, tokenizer_path=tokenizer_path
    )
