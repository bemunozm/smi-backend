"""Persistent OCR worker: JSON-lines protocol on stdin/stdout.

Launched once by the Node backend (`src/ocr/ocr.service.ts`, `spawn` in
`onModuleInit`) and kept alive across requests — loading both ONNX models
takes ~0.9s, far too slow to pay per-request.

Protocol:
    request   {"id": "<opaque>", "path": "<absolute path to an image file>"}\n
    response  {"id", "value", "status", "confidence", "florence", "crnn", "ms"}\n
    startup   a single {"ready": true, "version": "<manifest version>"}\n line
              on stdout once both models are loaded AND the sha256 check
              against `models.manifest.json` passes. Nothing is written to
              stdout before this line.

Rules this script follows (see the plan's "Backend" section):
    - stdout carries ONLY JSON-lines (the readiness line + one response line
      per request). Every log/diagnostic goes to stderr.
    - a single request's exception is caught and turned into an UNREADABLE
      response for that id — it never kills the process.
    - `OCR_THREADS` (default 2) sizes the Florence ONNX sessions and the
      global cv2 thread pool (`cv2.setNumThreads`, centralized here instead
      of at import time in some submodule — see litros/florence.py). The
      CRNN session is pinned to 1 thread regardless of OCR_THREADS: that's
      its own validated fastest config (~41ms warm; see
      ocr-train/eval_test.py), and the model is tiny enough that more
      threads only add scheduling overhead.
    - `OCR_MODELS_DIR` (default "<this dir>/models") is where the model
      files are expected. `models.manifest.json` (committed, sits next to
      this script) is the source of truth for which files/sizes/hashes are
      expected there.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST_PATH = os.path.join(HERE, "models.manifest.json")


def log(msg: str) -> None:
    print(f"[ocr-worker] {msg}", file=sys.stderr, flush=True)


def _write_line(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        log(f"invalid {name}={raw!r}, using default {default}")
        return default


def _load_manifest() -> dict:
    with open(MANIFEST_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _verify_models(models_dir: str, manifest: dict) -> None:
    problems: list[str] = []
    for entry in manifest["files"]:
        p = os.path.join(models_dir, entry["file"])
        if not os.path.isfile(p):
            problems.append(f"missing: {entry['file']}")
            continue
        size = os.path.getsize(p)
        if size != entry["bytes"]:
            problems.append(f"size mismatch for {entry['file']}: expected {entry['bytes']}, got {size}")
            continue
        digest = _sha256(p)
        if digest != entry["sha256"]:
            problems.append(f"sha256 mismatch for {entry['file']}")
    if problems:
        raise RuntimeError(
            f"model verification failed (models_dir={models_dir}, manifest={MANIFEST_PATH}): "
            + "; ".join(problems)
        )


def _handle_request(req: dict, florence, crnn_rec) -> None:
    # Imported lazily by main() before the loop starts; referenced here via
    # closure-free module lookup so this function stays easy to unit-test-less
    # (it's exercised indirectly through the TS integration test instead).
    from litros import crnn, ensemble

    rid = req.get("id")
    path = req.get("path")
    t0 = time.perf_counter()
    try:
        f = florence.read(path)
        c = crnn.read(path, crnn_rec)
        result = ensemble.combine(
            ensemble.ReaderResult(f.liters, f.confidence),
            ensemble.ReaderResult(c.liters, c.confidence),
        )
        resp = {
            "id": rid,
            "value": result.value,
            "status": result.status,
            "confidence": result.confidence,
            "florence": {"liters": f.liters, "confidence": f.confidence, "raw": f.raw},
            "crnn": {"liters": c.liters, "confidence": c.confidence, "raw": c.raw},
            "ms": round((time.perf_counter() - t0) * 1000, 1),
        }
    except Exception:
        log(f"request {rid!r} failed:\n{traceback.format_exc()}")
        resp = {
            "id": rid,
            "value": None,
            "status": "UNREADABLE",
            "confidence": 0.0,
            "florence": None,
            "crnn": None,
            "ms": round((time.perf_counter() - t0) * 1000, 1),
        }
    _write_line(resp)


def main() -> None:
    threads = _env_int("OCR_THREADS", 2)
    models_dir = os.environ.get("OCR_MODELS_DIR") or os.path.join(HERE, "models")

    import cv2

    cv2.setNumThreads(threads)  # centralized here (see module docstring)

    log(f"starting: models_dir={models_dir} threads={threads}")
    manifest = _load_manifest()
    _verify_models(models_dir, manifest)
    log("model files verified against manifest (sha256 ok)")

    from litros.crnn import CrnnRecognizer
    from litros.florence import FlorenceReader

    florence = FlorenceReader(models_dir, threads=threads)
    crnn_rec = CrnnRecognizer(os.path.join(models_dir, "crnn.onnx"), threads=1)
    log(f"models loaded (version={manifest['version']})")

    _write_line({"ready": True, "version": manifest["version"]})
    log("ready")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            log(f"ignoring non-JSON stdin line: {line[:200]!r}")
            continue
        if not isinstance(req, dict) or "id" not in req or "path" not in req:
            log(f"ignoring malformed request: {line[:200]!r}")
            continue
        _handle_request(req, florence, crnn_rec)

    log("stdin closed, exiting")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # A startup failure (missing/corrupt models, bad manifest, etc.) must
        # never print the ready line. Node sees the process die before/without
        # readiness, logs it, and applies its own restart-with-backoff — the
        # endpoint stays degraded (UNREADABLE) in the meantime.
        log("fatal error, exiting:\n" + traceback.format_exc())
        sys.exit(1)
