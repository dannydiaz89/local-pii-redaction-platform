"""Local PII inference contract boundary.

The model runtime is intentionally absent from Milestone 0. This package currently provides
strict generated models and protocol validation without logging or persisting request text.
"""

from .contracts import validate_contract

__all__ = ["validate_contract"]
