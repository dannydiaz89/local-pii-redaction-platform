"""Transport-neutral inference service (INF-001, INF-002, INF-005 to INF-010).

The service validates ingress against the canonical detect-request contract,
enforces limits before any recognition work, asks the runtime for chunk-relative
span candidates, rejects any candidate outside the chunk instead of clamping it,
caps detections, and validates egress against the detect-response contract.
Nothing here classifies an artifact as safe, performs replacement, or retains text.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from jsonschema.exceptions import ValidationError

from .bundle import PROTOCOL_VERSION, VerifiedBundle
from .contracts import validate_contract
from .runtime import SpanCandidate, SpanRuntime

DETECT_REQUEST_SCHEMA_ID = "https://local-pii.dev/schemas/detection/detect-request/1.0.0"
DETECT_RESPONSE_SCHEMA_ID = "https://local-pii.dev/schemas/detection/detect-response/1.0.0"


class InferenceError(Exception):
    """A typed, privacy-safe failure. Messages are fixed strings; no text or values."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable

    def envelope(self, correlation_id: str) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "correlationId": correlation_id,
        }


@dataclass(frozen=True)
class Limits:
    maximum_chunks: int = 64
    maximum_chunk_code_points: int = 20_000
    maximum_total_detections: int = 64_000
    maximum_detections_per_chunk_ceiling: int = 1_000


@dataclass(frozen=True)
class InferenceService:
    bundle: VerifiedBundle
    runtime: SpanRuntime
    limits: Limits = field(default_factory=Limits)

    def capabilities(self) -> dict:
        manifest = self.bundle.manifest
        return {
            "protocolVersions": [PROTOCOL_VERSION],
            "model": self.bundle.model_identity,
            "detector": {"id": self.runtime.id, "version": self.runtime.version},
            "entityTypes": sorted(manifest["entityTypes"]),
            "languages": sorted(manifest["languages"]),
            "limits": {
                "maximumChunks": self.limits.maximum_chunks,
                "maximumChunkCodePoints": self.limits.maximum_chunk_code_points,
                "maximumTotalDetections": self.limits.maximum_total_detections,
            },
            "qualification": "SYNTHETIC"
            if self.runtime.id == "synthetic-lexicon"
            else "EXPERIMENTAL",
        }

    def detect(self, request: object) -> dict:
        try:
            validate_contract(DETECT_REQUEST_SCHEMA_ID, request)
        except ValidationError as error:
            raise InferenceError(
                "SCHEMA_INVALID", "The detect request does not match its contract."
            ) from error
        assert isinstance(request, dict)
        chunks = request["chunks"]
        if len(chunks) > self.limits.maximum_chunks:
            raise InferenceError("INPUT_TOO_LARGE", "The request exceeds the chunk limit.")
        requested_types = frozenset(request["entityTypes"])
        supported_types = frozenset(self.bundle.manifest["entityTypes"])
        if not requested_types <= supported_types:
            raise InferenceError(
                "POLICY_UNSATISFIABLE", "A requested entity type is not supported by the model."
            )
        # Both fields are required by the contract validated above.
        minimum_confidence = float(request["minimumConfidence"])
        per_chunk_cap = min(
            int(request["options"]["maxDetectionsPerChunk"]),
            self.limits.maximum_detections_per_chunk_ceiling,
        )

        seen_chunk_ids: set[str] = set()
        detections: list[dict] = []
        warnings: list[str] = []
        for chunk in chunks:
            chunk_id = chunk["id"]
            if chunk_id in seen_chunk_ids:
                raise InferenceError("SCHEMA_INVALID", "Chunk identifiers must be unique.")
            seen_chunk_ids.add(chunk_id)
            text = chunk["text"]
            length = len(text)
            if length > self.limits.maximum_chunk_code_points:
                raise InferenceError("INPUT_TOO_LARGE", "A chunk exceeds the code-point limit.")
            try:
                candidates = self.runtime.detect(text, requested_types)
            except Exception as error:  # noqa: BLE001 - runtime failures must not leak details
                raise InferenceError("MODEL_OUTPUT_INVALID", "The model runtime failed.") from error
            accepted = [
                candidate
                for candidate in self._validated(candidates, length, requested_types)
                if candidate.confidence >= minimum_confidence
            ]
            if len(accepted) > per_chunk_cap:
                accepted = sorted(
                    accepted, key=lambda item: (-item.confidence, item.start, item.end)
                )[:per_chunk_cap]
                warnings.append(f"Detections were capped for chunk {chunk_id}."[:200])
            accepted.sort(key=lambda item: (item.start, item.end, item.entity_type))
            for candidate in accepted:
                detections.append(
                    {
                        "chunkId": chunk_id,
                        "entityType": candidate.entity_type,
                        "start": candidate.start,
                        "end": candidate.end,
                        "confidence": round(candidate.confidence, 6),
                        "detector": {"id": self.runtime.id, "version": self.runtime.version},
                    }
                )
            if len(detections) > self.limits.maximum_total_detections:
                raise InferenceError(
                    "DETECTION_LIMIT_EXCEEDED", "The request exceeds the detection limit."
                )

        response = {
            "schemaVersion": PROTOCOL_VERSION,
            "requestId": request["requestId"],
            "detections": detections,
            "model": self.bundle.model_identity,
            "warnings": warnings[:100],
        }
        try:
            validate_contract(DETECT_RESPONSE_SCHEMA_ID, response)
        except ValidationError as error:
            raise InferenceError(
                "MODEL_OUTPUT_INVALID", "The model produced a response outside its contract."
            ) from error
        return response

    @staticmethod
    def _validated(
        candidates: list[SpanCandidate], length: int, requested: frozenset[str]
    ) -> list[SpanCandidate]:
        for candidate in candidates:
            if (
                candidate.entity_type not in requested
                or not isinstance(candidate.start, int)
                or not isinstance(candidate.end, int)
                or candidate.start < 0
                or candidate.end > length
                or candidate.start >= candidate.end
                or not 0.0 <= candidate.confidence <= 1.0
            ):
                # Reject the whole chunk result rather than clamping (INF-002).
                raise InferenceError("MODEL_OUTPUT_INVALID", "The model returned an invalid span.")
        return list(candidates)
