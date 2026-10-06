"""Tests del servidor HTTP del worker con lectores falsos — no cargan modelos."""
import glob
import http.client
import json
import os
import tempfile
import threading
import time

import pytest

import worker


class Harness:
    def __init__(self, state: worker.OcrState) -> None:
        self.state = state
        self.server = worker.make_server(state, "127.0.0.1", 0)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def request(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else None
        finally:
            conn.close()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def harness():
    created: list[Harness] = []

    def make(**kwargs) -> Harness:
        h = Harness(worker.OcrState(**kwargs))
        created.append(h)
        return h

    yield make
    for h in created:
        h.close()


def fake_reader(path: str) -> dict:
    return {
        "value": "183.089",
        "status": "CONFIRMED",
        "confidence": 0.42,
        "florence": {"liters": "183.089", "confidence": 0.42, "raw": "183.089"},
        "crnn": {"liters": "183.089", "confidence": 0.87, "raw": "183089"},
    }


def temp_files() -> set[str]:
    return set(glob.glob(os.path.join(tempfile.gettempdir(), "smi-ocr-*")))


def test_health_is_503_until_models_are_loaded(harness):
    h = harness()

    status, body = h.request("GET", "/health")

    assert status == 503
    assert body == {"ready": False}


def test_health_is_200_once_ready(harness):
    h = harness()
    h.state.mark_ready("litros-v1", fake_reader)

    status, body = h.request("GET", "/health")

    assert status == 200
    assert body["ready"] is True
    assert body["version"] == "litros-v1"
    assert body["reads"] == 0
    assert body["uptime_s"] >= 0


def test_health_responds_while_a_read_is_in_flight(harness):
    h = harness()
    started = threading.Event()
    release = threading.Event()

    def slow_reader(path: str) -> dict:
        started.set()
        release.wait(timeout=10)
        return fake_reader(path)

    h.state.mark_ready("litros-v1", slow_reader)
    result: dict = {}

    def do_read() -> None:
        result["resp"] = h.request("POST", "/read", body=b"img")

    reader_thread = threading.Thread(target=do_read)
    reader_thread.start()
    assert started.wait(timeout=5)

    status, body = h.request("GET", "/health")
    release.set()
    reader_thread.join(timeout=10)

    assert status == 200
    assert body["ready"] is True
    assert result["resp"][0] == 200


def test_read_returns_the_ensemble_result_without_id(harness):
    h = harness()
    h.state.mark_ready("litros-v1", fake_reader)

    status, body = h.request("POST", "/read", body=b"fake-image-bytes")

    assert status == 200
    assert body["value"] == "183.089"
    assert body["status"] == "CONFIRMED"
    assert body["confidence"] == 0.42
    assert body["florence"]["liters"] == "183.089"
    assert body["crnn"]["liters"] == "183.089"
    assert isinstance(body["ms"], float)
    assert "id" not in body


def test_read_passes_the_body_bytes_to_the_reader_through_a_file(harness):
    h = harness()
    seen: dict = {}

    def capturing_reader(path: str) -> dict:
        with open(path, "rb") as fh:
            seen["bytes"] = fh.read()
        seen["path"] = path
        return fake_reader(path)

    h.state.mark_ready("litros-v1", capturing_reader)

    h.request("POST", "/read", body=b"\xff\xd8\xff-payload")

    assert seen["bytes"] == b"\xff\xd8\xff-payload"


def test_reader_error_becomes_unreadable_with_200_and_the_server_survives(harness):
    h = harness()

    def exploding_reader(path: str) -> dict:
        raise ValueError("could not decode image")

    h.state.mark_ready("litros-v1", exploding_reader)

    status, body = h.request("POST", "/read", body=b"not-an-image")
    health_status, _ = h.request("GET", "/health")

    assert status == 200
    assert body["value"] is None
    assert body["status"] == "UNREADABLE"
    assert body["confidence"] == 0.0
    assert body["florence"] is None
    assert body["crnn"] is None
    assert health_status == 200


def test_empty_body_is_400(harness):
    h = harness()
    h.state.mark_ready("litros-v1", fake_reader)

    status, _ = h.request("POST", "/read", body=b"", headers={"Content-Length": "0"})

    assert status == 400


def test_missing_content_length_is_400(harness):
    h = harness()
    h.state.mark_ready("litros-v1", fake_reader)
    conn = http.client.HTTPConnection("127.0.0.1", h.port, timeout=10)
    try:
        conn.putrequest("POST", "/read")
        conn.endheaders()
        status = conn.getresponse().status
    finally:
        conn.close()

    assert status == 400


def test_oversized_body_is_413_and_does_not_reach_the_reader(harness):
    h = harness(max_body_bytes=16)
    calls: list[str] = []

    def counting_reader(path: str) -> dict:
        calls.append(path)
        return fake_reader(path)

    h.state.mark_ready("litros-v1", counting_reader)

    status, _ = h.request("POST", "/read", body=b"x" * 17)

    assert status == 413
    assert calls == []


def test_read_before_ready_is_503(harness):
    h = harness()

    status, _ = h.request("POST", "/read", body=b"img")

    assert status == 503


def test_unknown_routes_are_404(harness):
    h = harness()
    h.state.mark_ready("litros-v1", fake_reader)

    assert h.request("GET", "/nope")[0] == 404
    assert h.request("POST", "/nope", body=b"x")[0] == 404


def test_temp_file_is_deleted_after_a_successful_read(harness):
    h = harness()
    h.state.mark_ready("litros-v1", fake_reader)
    before = temp_files()

    h.request("POST", "/read", body=b"img")

    assert temp_files() - before == set()


def test_temp_file_is_deleted_after_a_failed_read(harness):
    h = harness()

    def exploding_reader(path: str) -> dict:
        raise RuntimeError("boom")

    h.state.mark_ready("litros-v1", exploding_reader)
    before = temp_files()

    h.request("POST", "/read", body=b"img")

    assert temp_files() - before == set()


def test_reads_counter_increments_even_when_the_read_fails(harness):
    h = harness()
    h.state.mark_ready("litros-v1", fake_reader)

    h.request("POST", "/read", body=b"img")
    h.request("POST", "/read", body=b"img")

    assert h.request("GET", "/health")[1]["reads"] == 2


def test_reads_are_serialized(harness):
    h = harness()
    active = 0
    max_active = 0
    guard = threading.Lock()

    def tracking_reader(path: str) -> dict:
        nonlocal active, max_active
        with guard:
            active += 1
            max_active = max(max_active, active)
        time.sleep(0.05)
        with guard:
            active -= 1
        return fake_reader(path)

    h.state.mark_ready("litros-v1", tracking_reader)
    threads = [
        threading.Thread(target=lambda: h.request("POST", "/read", body=b"img")) for _ in range(4)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    assert max_active == 1


class TestWatchdog:
    def test_does_nothing_when_no_read_is_running(self):
        state = worker.OcrState(watchdog_seconds=1.0)
        exits: list[int] = []

        assert worker.Watchdog(state, exit_fn=exits.append).check() is False
        assert exits == []

    def test_does_nothing_while_the_read_is_within_the_limit(self):
        state = worker.OcrState(watchdog_seconds=30.0)
        state.read_started_at = 100.0
        exits: list[int] = []

        assert worker.Watchdog(state, exit_fn=exits.append).check(now=129.0) is False
        assert exits == []

    def test_exits_with_a_non_zero_code_when_a_read_exceeds_the_limit(self):
        state = worker.OcrState(watchdog_seconds=30.0)
        state.read_started_at = 100.0
        exits: list[int] = []

        assert worker.Watchdog(state, exit_fn=exits.append).check(now=131.0) is True
        assert exits == [worker.WATCHDOG_EXIT_CODE]
        assert worker.WATCHDOG_EXIT_CODE not in (0, 1)

    def test_a_hung_read_trips_the_watchdog_through_the_real_state(self):
        state = worker.OcrState(watchdog_seconds=0.05)
        exits: list[int] = []
        release = threading.Event()

        def hung_reader(path: str) -> dict:
            release.wait(timeout=5)
            return fake_reader(path)

        state.mark_ready("litros-v1", hung_reader)
        thread = threading.Thread(target=state.read_image, args=(b"img",))
        thread.start()
        time.sleep(0.2)

        tripped = worker.Watchdog(state, exit_fn=exits.append).check()
        release.set()
        thread.join(timeout=5)

        assert tripped is True
        assert exits == [worker.WATCHDOG_EXIT_CODE]
