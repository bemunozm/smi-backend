"""Agreement ensemble: combine a Florence reading and a CRNN reading of the
same photo into one result. No image/ML dependencies — pure logic, so it can
be unit-tested without onnxruntime, cv2, or the model files.

Rule (see the plan's "Decisiones de diseno"):
    CONFIRMED   both liters are non-null AND equal        -> value = that reading
                                                               confidence = min(florence, crnn)
    REVIEW      they differ, or only one is non-null       -> value = Florence's reading,
                                                               or CRNN's if Florence is null
                                                               confidence = that reading's own
    UNREADABLE  both are null                              -> value = None, confidence = 0
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Status = Literal["CONFIRMED", "REVIEW", "UNREADABLE"]


@dataclass
class ReaderResult:
    """Minimal shape both `litros.florence.FlorenceResult` and
    `litros.crnn.CrnnResult` satisfy (duck-typed on purpose, so this module
    never has to import either — see the docstring above)."""

    liters: str | None
    confidence: float


@dataclass
class EnsembleResult:
    value: str | None
    status: Status
    confidence: float


def combine(florence: ReaderResult, crnn: ReaderResult) -> EnsembleResult:
    f, c = florence.liters, crnn.liters
    if f is not None and f == c:
        return EnsembleResult(value=f, status="CONFIRMED", confidence=min(florence.confidence, crnn.confidence))
    if f is None and c is None:
        return EnsembleResult(value=None, status="UNREADABLE", confidence=0.0)
    if f is not None:
        return EnsembleResult(value=f, status="REVIEW", confidence=florence.confidence)
    return EnsembleResult(value=c, status="REVIEW", confidence=crnn.confidence)
