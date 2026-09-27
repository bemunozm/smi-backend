"""Tests for the pure functions in litros.crnn: regexes, CTC greedy decode,
the $ cross-check, and EXIF orientation handling. No model files needed."""
import numpy as np
import pytest

from litros.crnn import (
    CHARSET,
    LITERS_RE,
    _apply_exif_orientation,
    _cross_check,
    greedy_decode,
    read_confidence,
)


def test_liters_re():
    assert LITERS_RE.fullmatch("183.089")
    assert not LITERS_RE.fullmatch("183.08")


def test_cross_check_agrees_within_tolerance():
    # 61.234 L * 1 $/L ~= 61 $ (rounding) -> True
    assert _cross_check("61.234", "61", None) is True


def test_cross_check_disagrees():
    assert _cross_check("183.089", "1", None) is False


def test_cross_check_none_when_dollars_missing():
    assert _cross_check("183.089", None, None) is None


def test_cross_check_none_when_liters_missing():
    assert _cross_check(None, "61", None) is None


def test_cross_check_uses_explicit_price_when_given():
    # 174.637 L * 001.0 $/L ~= 175 $ (within 1 peso) -> True
    assert _cross_check("174.637", "175", "001.0") is True


def _fake_logp(text: str) -> np.ndarray:
    """Builds a (T, C) log-prob array that greedy-decodes to exactly `text`
    (one CTC-blank frame between repeated/consecutive symbols to avoid
    accidental merging), each emitted class as close to certain (logp ~ 0)."""
    nclass = len(CHARSET) + 1
    frames = []
    for ch in text:
        row = np.full(nclass, -20.0, np.float32)
        row[CHARSET.index(ch) + 1] = 0.0
        frames.append(row)
        blank = np.full(nclass, -20.0, np.float32)
        blank[0] = 0.0
        frames.append(blank)
    return np.stack(frames)


def test_greedy_decode_reads_simple_text():
    logp = _fake_logp("183.089")

    text, confs, blank_min = greedy_decode(logp)

    assert text == "183.089"
    assert len(confs) == len(text)
    assert blank_min > 0.9


def test_read_confidence_is_min_of_chars_and_blanks():
    assert read_confidence([0.9, 0.5, 0.8], 0.95) == 0.5
    assert read_confidence([0.9, 0.2, 0.8], 0.1) == 0.1


def test_read_confidence_zero_when_nothing_decoded():
    assert read_confidence([], 1.0) == 0.0


# Four distinct, non-symmetric corner values on a NON-SQUARE (H=10, W=20)
# image — a same-pixel-count check can't tell a correct rotation from a
# wrong one (or 6 swapped with 8: both reshape to (20, 10) and both are
# valid permutations of the same pixels), only per-corner identity can.
#
# Expected corners were cross-validated two ways before being hardcoded
# here: (1) against `PIL.ImageOps.exif_transpose` applied to a real EXIF
# orientation tag round-tripped through a lossless TIFF (JPEG's DCT blurs
# single-pixel corners at this resolution), reading back RGB->BGR to match
# this module's cv2 convention; (2) against this file's own
# `_apply_exif_orientation`. Both oracles agree on all 8 orientations.
_TL, _TR, _BL, _BR = (1, 2, 3), (2, 2, 2), (3, 3, 3), (4, 4, 4)
_H, _W = 10, 20

_EXPECTED_CORNERS = {
    1: {"shape": (_H, _W), "TL": _TL, "TR": _TR, "BL": _BL, "BR": _BR},
    2: {"shape": (_H, _W), "TL": _TR, "TR": _TL, "BL": _BR, "BR": _BL},
    3: {"shape": (_H, _W), "TL": _BR, "TR": _BL, "BL": _TR, "BR": _TL},
    4: {"shape": (_H, _W), "TL": _BL, "TR": _BR, "BL": _TL, "BR": _TR},
    5: {"shape": (_W, _H), "TL": _TL, "TR": _BL, "BL": _TR, "BR": _BR},
    6: {"shape": (_W, _H), "TL": _BL, "TR": _TL, "BL": _BR, "BR": _TR},
    7: {"shape": (_W, _H), "TL": _BR, "TR": _TR, "BL": _BL, "BR": _TL},
    8: {"shape": (_W, _H), "TL": _TR, "TR": _BR, "BL": _TL, "BR": _BL},
}


def _corners_of(img: np.ndarray) -> dict:
    h, w = img.shape[:2]
    return {
        "shape": (h, w),
        "TL": tuple(int(v) for v in img[0, 0]),
        "TR": tuple(int(v) for v in img[0, w - 1]),
        "BL": tuple(int(v) for v in img[h - 1, 0]),
        "BR": tuple(int(v) for v in img[h - 1, w - 1]),
    }


@pytest.mark.parametrize(
    "orientation",
    [1, 2, 3, 4, 5, 6, 7, 8],
)
def test_apply_exif_orientation_matches_reference_corners(orientation):
    img = np.zeros((_H, _W, 3), np.uint8)
    img[0, 0] = _TL
    img[0, _W - 1] = _TR
    img[_H - 1, 0] = _BL
    img[_H - 1, _W - 1] = _BR

    out = _apply_exif_orientation(img, orientation)

    assert _corners_of(out) == _EXPECTED_CORNERS[orientation]
