"""Pure-logic tests for the agreement ensemble — no models, no cv2/onnx needed."""
from litros.ensemble import ReaderResult, combine


def test_confirmed_when_both_agree():
    result = combine(ReaderResult("183.089", 0.42), ReaderResult("183.089", 0.87))

    assert result.value == "183.089"
    assert result.status == "CONFIRMED"
    assert result.confidence == 0.42  # min(0.42, 0.87)


def test_review_when_readings_differ():
    result = combine(ReaderResult("183.089", 0.9), ReaderResult("183.080", 0.5))

    assert result.value == "183.089"  # Florence is primary
    assert result.status == "REVIEW"
    assert result.confidence == 0.9  # Florence's own confidence


def test_review_when_only_florence_reads():
    result = combine(ReaderResult("183.089", 0.9), ReaderResult(None, 0.0))

    assert result.value == "183.089"
    assert result.status == "REVIEW"
    assert result.confidence == 0.9


def test_review_when_only_crnn_reads():
    result = combine(ReaderResult(None, 0.0), ReaderResult("183.089", 0.6))

    assert result.value == "183.089"
    assert result.status == "REVIEW"
    assert result.confidence == 0.6


def test_unreadable_when_both_null():
    result = combine(ReaderResult(None, 0.0), ReaderResult(None, 0.0))

    assert result.value is None
    assert result.status == "UNREADABLE"
    assert result.confidence == 0.0


def test_confirmed_takes_the_min_confidence_even_when_florence_is_lower():
    result = combine(ReaderResult("061.234", 0.3), ReaderResult("061.234", 0.95))

    assert result.status == "CONFIRMED"
    assert result.confidence == 0.3
