"""Span runtimes behind the inference service.

A runtime turns one bounded chunk of canonical text into chunk-relative Unicode
code-point span candidates. The service owns validation, limits, and the wire
contract; a runtime owns only recognition. The synthetic lexicon runtime here is a
deterministic, offline stand-in that exercises every contract path without a
trained model. It is labelled as such in every manifest and response and must
never be presented as a qualified detector.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

SYNTHETIC_LEXICON_RUNTIME = "synthetic-lexicon-v1"
SUPPORTED_RUNTIMES = frozenset({SYNTHETIC_LEXICON_RUNTIME})


@dataclass(frozen=True)
class SpanCandidate:
    """A chunk-relative half-open Unicode code-point span."""

    entity_type: str
    start: int
    end: int
    confidence: float


class SpanRuntime(Protocol):
    """Recognition boundary. Implementations receive text only, never files or identities."""

    @property
    def id(self) -> str: ...

    @property
    def version(self) -> str: ...

    def detect(self, text: str, entity_types: frozenset[str]) -> list[SpanCandidate]: ...


class RuntimeConfigurationError(ValueError):
    """The runtime assets are malformed. The message names a component, never content."""


def _code_point_offsets(text: str) -> list[int]:
    """Map each UTF-16-free Python index to itself; Python strings are code-point indexed."""
    return list(range(len(text) + 1))


class SyntheticLexiconRuntime:
    """Exact-value and anchored-pattern matcher driven by a committed synthetic lexicon.

    ``model.json`` shape::

        {"schemaVersion": "1.0.0", "runtime": "synthetic-lexicon-v1",
         "entries": [{"entityType": "PERSON", "value": "Mara Vellum", "confidence": 0.93},
                     {"entityType": "DATE_OF_BIRTH", "pattern": "\\b\\d{4}-\\d{2}-\\d{2}\\b",
                      "confidence": 0.71}]}

    Every occurrence of a value or pattern match becomes a candidate. Python strings are
    indexed by code point, so ``re`` match offsets are already the contract's offset unit.
    """

    id = "synthetic-lexicon"
    version = "0.1.0"

    def __init__(self, model_path: Path) -> None:
        try:
            raw = json.loads(model_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise RuntimeConfigurationError("model") from error
        if (
            not isinstance(raw, dict)
            or raw.get("schemaVersion") != "1.0.0"
            or raw.get("runtime") != SYNTHETIC_LEXICON_RUNTIME
            or not isinstance(raw.get("entries"), list)
            or len(raw["entries"]) > 10_000
        ):
            raise RuntimeConfigurationError("model")
        values: list[tuple[str, str, float]] = []
        patterns: list[tuple[str, re.Pattern[str], float]] = []
        for entry in raw["entries"]:
            if not isinstance(entry, dict):
                raise RuntimeConfigurationError("model")
            entity_type = entry.get("entityType")
            confidence = entry.get("confidence")
            if (
                not isinstance(entity_type, str)
                or not isinstance(confidence, int | float)
                or isinstance(confidence, bool)
                or not 0.0 <= float(confidence) <= 1.0
            ):
                raise RuntimeConfigurationError("model")
            if isinstance(entry.get("value"), str) and entry["value"]:
                values.append((entity_type, entry["value"], float(confidence)))
            elif isinstance(entry.get("pattern"), str) and entry["pattern"]:
                try:
                    patterns.append((entity_type, re.compile(entry["pattern"]), float(confidence)))
                except re.error as error:
                    raise RuntimeConfigurationError("model") from error
            else:
                raise RuntimeConfigurationError("model")
        self._values = tuple(values)
        self._patterns = tuple(patterns)

    def detect(self, text: str, entity_types: frozenset[str]) -> list[SpanCandidate]:
        candidates: list[SpanCandidate] = []
        for entity_type, value, confidence in self._values:
            if entity_type not in entity_types:
                continue
            start = text.find(value)
            while start >= 0:
                candidates.append(SpanCandidate(entity_type, start, start + len(value), confidence))
                start = text.find(value, start + len(value))
        for entity_type, pattern, confidence in self._patterns:
            if entity_type not in entity_types:
                continue
            for match in pattern.finditer(text):
                if match.end() > match.start():
                    candidates.append(
                        SpanCandidate(entity_type, match.start(), match.end(), confidence)
                    )
        candidates.sort(key=lambda item: (item.start, item.end, item.entity_type))
        return candidates


def create_runtime(runtime_id: str, model_path: Path) -> SpanRuntime:
    if runtime_id == SYNTHETIC_LEXICON_RUNTIME:
        return SyntheticLexiconRuntime(model_path)
    raise RuntimeConfigurationError("runtime")
