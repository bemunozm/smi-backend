"""Tests for the pure functions in litros.florence: LITERS_RE and parse_output.
No model files or onnxruntime needed — FlorenceReader.__init__ imports
onnxruntime/tokenizers lazily, so importing this module stays cheap."""
from litros.florence import LITERS_RE, parse_output


def test_liters_re_accepts_the_display_format():
    assert LITERS_RE.fullmatch("183.089")
    assert LITERS_RE.fullmatch("1.089")
    assert LITERS_RE.fullmatch("999.999")


def test_liters_re_rejects_malformed_values():
    assert not LITERS_RE.fullmatch("1830.89")
    assert not LITERS_RE.fullmatch("183.08")
    assert not LITERS_RE.fullmatch("183")
    assert not LITERS_RE.fullmatch("abc.def")


def test_parse_output_reads_the_liters_field():
    parsed = parse_output("L: 1 8 3 . 0 8 9")

    assert parsed == {"liters": "183.089", "dollars": None, "price": None}


def test_parse_output_reads_multi_field_output():
    parsed = parse_output("L: 1 7 4 . 6 3 7 | D: 1 7 5 | P: 0 0 1 . 0")

    assert parsed["liters"] == "174.637"
    assert parsed["dollars"] == 175
    assert parsed["price"] == 1.0


def test_parse_output_tolerates_a_bare_number():
    parsed = parse_output("183.089")

    assert parsed["liters"] == "183.089"


def test_parse_output_rejects_malformed_liters():
    parsed = parse_output("L: 1 8 3 0 . 8 9")

    assert parsed["liters"] is None


def test_parse_output_strips_special_tokens():
    parsed = parse_output("<s>L: 1 8 3 . 0 8 9</s><pad>")

    assert parsed["liters"] == "183.089"
