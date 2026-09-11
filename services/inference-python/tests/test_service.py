from __future__ import annotations

import io
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path

import pytest
from local_pii_inference.bundle import BundleError, load_bundle
from local_pii_inference.contracts import validate_contract
from local_pii_inference.runtime import SpanCandidate, create_runtime
from local_pii_inference.service import InferenceError, InferenceService, Limits
from local_pii_inference.stdio import handle, read_frame, serve, write_frame

REQUEST_ID = "d9b8a330-8d9a-4f6f-8f11-5b2f10e53967"
RESPONSE_SCHEMA = "https://local-pii.dev/schemas/detection/detect-response/1.0.0"


def repository_root() -> Path:
    return Path(__file__).resolve().parents[3]


def bundle_root() -> Path:
    return repository_root() / "fixtures" / "models" / "synthetic-lexicon-v1"


def service() -> InferenceService:
    bundle = load_bundle(bundle_root())
    return InferenceService(
        bundle=bundle, runtime=create_runtime(bundle.manifest["runtime"], bundle.model_path)
    )


def request(text: str, *, entity_types: list[str] | None = None, **overrides: object) -> dict:
    payload: dict = {
        "schemaVersion": "1.0.0",
        "requestId": REQUEST_ID,
        "chunks": [{"id": "chunk-1", "text": text, "absoluteStart": 0}],
        "entityTypes": entity_types or ["PERSON", "DATE_OF_BIRTH", "ORGANIZATION"],
        "minimumConfidence": 0.0,
        "options": {"maxDetectionsPerChunk": 1000},
    }
    payload.update(overrides)
    return payload


def test_bundle_verifies_digests_and_fails_closed_on_tampering(tmp_path: Path) -> None:
    verified = load_bundle(bundle_root())
    assert verified.model_identity["runtime"] == "synthetic-lexicon-v1"
    tampered = tmp_path / "bundle"
    shutil.copytree(bundle_root(), tampered)
    (tampered / "model.json").write_text("{}", encoding="utf-8")
    with pytest.raises(BundleError) as failure:
        load_bundle(tampered)
    assert failure.value.component == "model"
    assert str(tampered) not in str(failure.value)
    (tampered / "manifest.json").unlink()
    with pytest.raises(BundleError) as missing:
        load_bundle(tampered)
    assert missing.value.component == "manifest"


def test_detect_returns_contract_valid_code_point_spans_after_astral_text() -> None:
    text = "😀 Mara Vellum was born 1988-02-29 at Halcyon Tidewater Labs."
    response = service().detect(request(text))
    validate_contract(RESPONSE_SCHEMA, response)
    spans = {(d["entityType"], d["start"], d["end"]) for d in response["detections"]}
    person = text.index("Mara Vellum")
    dob = text.index("1988-02-29")
    org = text.index("Halcyon Tidewater Labs")
    assert ("PERSON", person, person + len("Mara Vellum")) in spans
    assert ("DATE_OF_BIRTH", dob, dob + 10) in spans
    assert ("ORGANIZATION", org, org + len("Halcyon Tidewater Labs")) in spans
    assert response["model"]["id"] == "synthetic-lexicon"
    assert all(d["detector"]["id"] == "synthetic-lexicon" for d in response["detections"])
    assert "Mara" not in json.dumps({k: v for k, v in response.items() if k != "detections"})


def test_detect_respects_requested_types_and_minimum_confidence() -> None:
    text = "Mara Vellum, born 1977-05-05."
    only_person = service().detect(request(text, entity_types=["PERSON"]))
    assert {d["entityType"] for d in only_person["detections"]} == {"PERSON"}
    confident = service().detect(request(text, minimumConfidence=0.9))
    assert {d["entityType"] for d in confident["detections"]} == {"PERSON"}
    unsupported = request(text, entity_types=["EMAIL"])
    with pytest.raises(InferenceError) as failure:
        service().detect(unsupported)
    assert failure.value.code == "POLICY_UNSATISFIABLE"


def test_detect_rejects_contract_violations_and_limits_before_recognition() -> None:
    svc = service()
    with pytest.raises(InferenceError) as invalid:
        svc.detect({"schemaVersion": "1.0.0"})
    assert invalid.value.code == "SCHEMA_INVALID"
    small = InferenceService(
        bundle=svc.bundle, runtime=svc.runtime, limits=Limits(maximum_chunks=1)
    )
    two_chunks = request("a")
    two_chunks["chunks"].append({"id": "chunk-2", "text": "b", "absoluteStart": 1})
    with pytest.raises(InferenceError) as too_many:
        small.detect(two_chunks)
    assert too_many.value.code == "INPUT_TOO_LARGE"
    duplicate = request("a")
    duplicate["chunks"].append({"id": "chunk-1", "text": "b", "absoluteStart": 1})
    with pytest.raises(InferenceError) as dup:
        svc.detect(duplicate)
    assert dup.value.code == "SCHEMA_INVALID"


def test_detect_caps_per_chunk_with_a_warning_and_keeps_offsets_sorted() -> None:
    text = " ".join(f"born 19{i:02d}-01-01" for i in range(5))
    response = service().detect(
        request(text, entity_types=["DATE_OF_BIRTH"], options={"maxDetectionsPerChunk": 2})
    )
    validate_contract(RESPONSE_SCHEMA, response)
    assert len(response["detections"]) == 2
    assert response["warnings"] == ["Detections were capped for chunk chunk-1."]
    starts = [d["start"] for d in response["detections"]]
    assert starts == sorted(starts)


class _BrokenRuntime:
    id = "broken"
    version = "0.0.1"

    def __init__(self, candidates: list[SpanCandidate] | Exception) -> None:
        self._candidates = candidates

    def detect(self, text: str, entity_types: frozenset[str]) -> list[SpanCandidate]:
        if isinstance(self._candidates, Exception):
            raise self._candidates
        return self._candidates


@pytest.mark.parametrize(
    "candidates",
    [
        [SpanCandidate("PERSON", 0, 999, 0.5)],
        [SpanCandidate("PERSON", 3, 3, 0.5)],
        [SpanCandidate("PERSON", 0, 2, 1.5)],
        [SpanCandidate("EMAIL", 0, 2, 0.5)],
        RuntimeError("secret runtime detail"),
    ],
)
def test_invalid_runtime_output_rejects_the_response_instead_of_clamping(
    candidates: object,
) -> None:
    bundle = load_bundle(bundle_root())
    svc = InferenceService(bundle=bundle, runtime=_BrokenRuntime(candidates))  # type: ignore[arg-type]
    with pytest.raises(InferenceError) as failure:
        svc.detect(request("Mara Vellum"))
    assert failure.value.code == "MODEL_OUTPUT_INVALID"
    assert "secret" not in failure.value.message
    assert "Mara" not in failure.value.message


def test_stdio_frames_round_trip_and_reject_oversized_or_truncated_frames() -> None:
    svc = service()
    inbound = io.BytesIO()
    write_frame(inbound, {"type": "ready"})
    write_frame(inbound, {"type": "capabilities"})
    write_frame(
        inbound, {"type": "detect", "correlationId": "cor_test", "request": request("Mara Vellum")}
    )
    write_frame(inbound, {"type": "detect", "correlationId": "cor_test", "request": {"bad": True}})
    write_frame(inbound, {"type": "unknown"})
    inbound.seek(0)
    outbound = io.BytesIO()
    assert serve(svc, inbound, outbound) == 0
    outbound.seek(0)
    replies = []
    while (frame := read_frame(outbound)) is not None:
        replies.append(frame)
    assert [reply["type"] for reply in replies] == [
        "ready",
        "capabilities",
        "detect",
        "detect",
        "error",
    ]
    assert replies[0]["ok"] and replies[0]["model"]["id"] == "synthetic-lexicon"
    assert replies[1]["capabilities"]["qualification"] == "SYNTHETIC"
    assert replies[2]["ok"] and replies[2]["response"]["detections"][0]["entityType"] == "PERSON"
    assert replies[3] == {
        "type": "detect",
        "ok": False,
        "error": {
            "code": "SCHEMA_INVALID",
            "message": "The detect request does not match its contract.",
            "retryable": False,
            "correlationId": "cor_test",
        },
    }
    assert replies[4]["error"]["code"] == "SCHEMA_INVALID"

    oversized = io.BytesIO(struct.pack(">I", 9 * 1024 * 1024))
    assert serve(svc, oversized, io.BytesIO()) == 2
    truncated = io.BytesIO(struct.pack(">I", 10) + b"{}")
    assert serve(svc, truncated, io.BytesIO()) == 2
    assert handle(svc, {"type": "detect"})["error"]["code"] == "SCHEMA_INVALID"


def test_subprocess_profile_serves_a_verified_bundle_and_fails_closed_without_one(
    tmp_path: Path,
) -> None:
    def run(bundle: Path, frames: list[dict]) -> tuple[int, list[dict], bytes]:
        stdin = io.BytesIO()
        for frame in frames:
            write_frame(stdin, frame)
        completed = subprocess.run(
            [sys.executable, "-m", "local_pii_inference", "--bundle", str(bundle)],
            input=stdin.getvalue(),
            capture_output=True,
            timeout=60,
            check=False,
        )
        out = io.BytesIO(completed.stdout)
        replies = []
        while (frame := read_frame(out)) is not None:
            replies.append(frame)
        return completed.returncode, replies, completed.stderr

    code, replies, stderr = run(
        bundle_root(), [{"type": "ready"}, {"type": "detect", "request": request("Mara Vellum")}]
    )
    assert code == 0 and stderr == b""
    assert replies[0]["ok"] and replies[1]["ok"]
    assert replies[1]["response"]["detections"][0]["start"] == 0

    empty = tmp_path / "empty"
    empty.mkdir()
    code, replies, stderr = run(empty, [{"type": "ready"}])
    assert code == 3 and stderr == b""
    assert replies == [
        {
            "type": "ready",
            "ok": False,
            "error": {
                "code": "SUPPLY_CHAIN_INVALID",
                "message": "The model bundle component is invalid: manifest.",
                "retryable": False,
                "correlationId": "cor_inference_startup",
            },
        }
    ]
