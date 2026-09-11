"""Local subprocess profile: length-prefixed JSON frames over stdio (OQ-007, local).

Each frame is a 4-byte big-endian length followed by that many bytes of UTF-8 JSON.
The profile opens no socket, so the default ephemeral CLI keeps its no-network
posture while consulting a contextual model. Frames are bounded; an oversized or
malformed frame ends the session rather than being skipped, and the caller treats
the model as unavailable. Message text never reaches stderr or any log.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path
from typing import BinaryIO

from .bundle import BundleError, load_bundle
from .runtime import RuntimeConfigurationError, create_runtime
from .service import InferenceError, InferenceService

HEADER = struct.Struct(">I")
MAXIMUM_FRAME_BYTES = 8 * 1024 * 1024
MAXIMUM_CORRELATION_ID_LENGTH = 128


class FrameError(Exception):
    """The stream cannot be parsed further; the session ends."""


def write_frame(stream: BinaryIO, message: dict) -> None:
    payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > MAXIMUM_FRAME_BYTES:
        raise FrameError("frame")
    stream.write(HEADER.pack(len(payload)))
    stream.write(payload)
    stream.flush()


def read_frame(stream: BinaryIO) -> dict | None:
    header = stream.read(HEADER.size)
    if not header:
        return None
    if len(header) != HEADER.size:
        raise FrameError("header")
    (length,) = HEADER.unpack(header)
    if length == 0 or length > MAXIMUM_FRAME_BYTES:
        raise FrameError("length")
    payload = stream.read(length)
    if len(payload) != length:
        raise FrameError("payload")
    try:
        message = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise FrameError("json") from error
    if not isinstance(message, dict):
        raise FrameError("shape")
    return message


def _correlation_id(message: dict) -> str:
    value = message.get("correlationId")
    if isinstance(value, str) and 1 <= len(value) <= MAXIMUM_CORRELATION_ID_LENGTH:
        return value
    return "cor_inference_stdio"


def handle(service: InferenceService, message: dict) -> dict:
    kind = message.get("type")
    correlation_id = _correlation_id(message)
    if kind == "ready":
        return {"type": "ready", "ok": True, "model": service.bundle.model_identity}
    if kind == "capabilities":
        return {"type": "capabilities", "ok": True, "capabilities": service.capabilities()}
    if kind == "detect":
        try:
            response = service.detect(message.get("request"))
        except InferenceError as error:
            return {"type": "detect", "ok": False, "error": error.envelope(correlation_id)}
        return {"type": "detect", "ok": True, "response": response}
    return {
        "type": "error",
        "ok": False,
        "error": InferenceError("SCHEMA_INVALID", "The message type is unsupported.").envelope(
            correlation_id
        ),
    }


def serve(service: InferenceService, stdin: BinaryIO, stdout: BinaryIO) -> int:
    while True:
        try:
            message = read_frame(stdin)
        except FrameError:
            return 2
        if message is None:
            return 0
        write_frame(stdout, handle(service, message))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="local_pii_inference", add_help=True)
    parser.add_argument(
        "--bundle", required=True, help="Directory holding a verified model bundle."
    )
    arguments = parser.parse_args(argv)
    stdout = sys.stdout.buffer
    try:
        bundle = load_bundle(Path(arguments.bundle))
        runtime = create_runtime(bundle.manifest["runtime"], bundle.model_path)
    except (BundleError, RuntimeConfigurationError) as error:
        component = getattr(error, "component", str(error))
        write_frame(
            stdout,
            {
                "type": "ready",
                "ok": False,
                "error": {
                    "code": "SUPPLY_CHAIN_INVALID",
                    "message": f"The model bundle component is invalid: {component}.",
                    "retryable": False,
                    "correlationId": "cor_inference_startup",
                },
            },
        )
        return 3
    return serve(InferenceService(bundle=bundle, runtime=runtime), sys.stdin.buffer, stdout)
