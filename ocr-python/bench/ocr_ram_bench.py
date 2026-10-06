"""Benchmark multiplataforma del worker OCR: RAM fisica y tiempo por foto.

Mide el proceso del worker DESDE AFUERA (psutil), igual que lo veria un
operador, para dimensionar el servidor y comparar plataformas (Windows x86,
Docker x86, Linux ARM64) sobre las mismas fotos.

Dos modos:
    --spawn          lanza `python worker.py` local (puerto libre) y lo mide.
                     Siempre parte de un worker fresco.
    --pid N --url U  mide un worker que ya corre (ej. el contenedor
                     `ocr-worker`, visible por `pid: "service:ocr-worker"`).
                     Verifica que este FRESCO (0 lecturas en /health): si ya
                     proceso fotos, el momento "modelos recien cargados" no
                     es valido y el resultado lo avisa (`worker_fresh: false`).

Salida en `--out`:
    summary.json   RAM en cada momento, tiempos, plataforma y configuracion.
    per_photo.csv  una fila por foto.
    per_photo.json lo mismo en JSON (insumo de `compare_runs.py`).

La RAM es RSS (memoria fisica residente). El pico se toma de dos fuentes:
el muestreo cada 50 ms y el contador del SO (`peak_wset` en Windows, `VmHWM`
de /proc/<pid>/status en Linux), que no se pierde un pico entre muestras.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import socket
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import psutil

MB = 1024 * 1024
HERE = Path(__file__).resolve().parent
OCR_DIR = HERE.parent
SAMPLE_INTERVAL_S = 0.05
READY_TIMEOUT_S = 180.0
REQUEST_TIMEOUT_S = 120.0
SETTLE_AFTER_READY_S = 0.5
PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png"}
# Cantidad de fotos tras las que se registra la RAM ("tras la 1a, 3a, 6a, 20a").
CHECKPOINTS = (1, 3, 6, 20)
CSV_FIELDS = [
    "file",
    "value",
    "status",
    "confidence",
    "florence_liters",
    "crnn_liters",
    "ms",
    "worker_ms",
    "rss_mb",
]


def log(msg: str) -> None:
    print(f"[bench] {msg}", file=sys.stderr, flush=True)


def http_json(method: str, url: str, body: bytes | None = None, timeout: float = REQUEST_TIMEOUT_S):
    """Devuelve (status, json|None). Un 4xx/5xx no lanza: el bench lo registra."""
    req = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/octet-stream")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw or b"null")
        except json.JSONDecodeError:
            return err.code, None


def wait_ready(url: str, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_error = "no response"
    while time.monotonic() < deadline:
        try:
            status, body = http_json("GET", f"{url}/health", timeout=5)
            if status == 200 and isinstance(body, dict) and body.get("ready") is True:
                return body
            last_error = f"status={status} body={body}"
        except (urllib.error.URLError, OSError) as err:
            last_error = str(err)
        time.sleep(0.25)
    raise RuntimeError(f"worker not ready after {timeout}s ({last_error})")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def resolve_worker_process(launcher: psutil.Process) -> psutil.Process:
    """El interprete real a medir.

    En Windows, el `python.exe` de un venv es un lanzador que arranca al
    interprete verdadero como proceso hijo: medir el lanzador daria ~5 MB.
    En Linux no hay lanzador y se mide el propio proceso.
    """
    target = launcher
    for _ in range(100):
        kids = target.children()
        python_kids = [k for k in kids if "python" in k.name().lower()]
        if len(python_kids) == 1:
            target = python_kids[0]
            continue
        if kids or target is not launcher:
            break
        time.sleep(0.05)
    return target


def os_peak_mb(proc: psutil.Process) -> float | None:
    """Pico de RSS segun el SO (no depende del muestreo)."""
    try:
        info = proc.memory_info()
    except psutil.Error:
        return None
    peak_wset = getattr(info, "peak_wset", None)
    if peak_wset is not None:
        return peak_wset / MB
    try:
        with open(f"/proc/{proc.pid}/status", encoding="ascii") as fh:
            for line in fh:
                if line.startswith("VmHWM:"):
                    return int(line.split()[1]) / 1024  # kB -> MB
    except OSError:
        return None
    return None


def cpu_model() -> str:
    try:
        with open("/proc/cpuinfo", encoding="utf-8") as fh:
            for line in fh:
                if line.lower().startswith(("model name", "hardware")):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    try:
        out = subprocess.run(["lscpu"], capture_output=True, text=True, timeout=5, check=False).stdout
        for line in out.splitlines():
            if line.startswith("Model name:"):
                return line.split(":", 1)[1].strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return platform.processor() or "unknown"


class RssSampler:
    """Muestrea el RSS del proceso en un hilo, cada `SAMPLE_INTERVAL_S`."""

    def __init__(self, proc: psutil.Process) -> None:
        self._proc = proc
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="rss-sampler", daemon=True)
        self.samples: list[tuple[float, float]] = []
        self._t0 = time.perf_counter()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                rss = self._proc.memory_info().rss / MB
            except psutil.Error:
                return
            self.samples.append((time.perf_counter() - self._t0, rss))
            time.sleep(SAMPLE_INTERVAL_S)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)

    def max_mb(self, until: float | None = None) -> float | None:
        values = [rss for t, rss in self.samples if until is None or t <= until]
        return max(values) if values else None

    def elapsed(self) -> float:
        return time.perf_counter() - self._t0


def rss_mb(proc: psutil.Process) -> float:
    return proc.memory_info().rss / MB


def percentile(values: list[float], pct: float) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round(pct / 100 * len(ordered))) - 1))
    return ordered[index]


def list_photos(directory: Path, limit: int | None) -> list[Path]:
    photos = sorted(p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in PHOTO_SUFFIXES)
    return photos[:limit] if limit else photos


def read_worker_threads(proc: psutil.Process, fallback: str) -> str:
    try:
        return proc.environ().get("OCR_THREADS", fallback)
    except (psutil.Error, OSError):
        return fallback


def run(args: argparse.Namespace) -> dict[str, Any]:
    photos_dir = Path(args.photos)
    photos = list_photos(photos_dir, args.limit)
    if not photos:
        raise SystemExit(f"no photos (jpg/jpeg/png) in {photos_dir}")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    launched: subprocess.Popen | None = None
    stderr_log = None
    t_start = time.perf_counter()

    if args.spawn:
        port = free_port()
        url = f"http://127.0.0.1:{port}"
        env = dict(
            os.environ,
            OCR_MODELS_DIR=str(args.models_dir),
            OCR_THREADS=str(args.threads),
            OCR_PORT=str(port),
            OCR_HOST="127.0.0.1",
        )
        stderr_log = open(out_dir / "worker_stderr.log", "w", encoding="utf-8")
        launched = subprocess.Popen(
            [sys.executable, str(OCR_DIR / "worker.py")],
            cwd=str(OCR_DIR),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=stderr_log,
        )
        proc = resolve_worker_process(psutil.Process(launched.pid))
        log(f"spawned worker pid={launched.pid} measuring pid={proc.pid} url={url}")
    else:
        url = args.url.rstrip("/")
        try:
            proc = psutil.Process(args.pid)
        except psutil.NoSuchProcess:
            raise SystemExit(f"pid {args.pid} not visible: the bench container needs pid: service:<worker>")
        log(f"attached to pid={proc.pid} url={url}")

    sampler = RssSampler(proc)
    sampler.start()
    try:
        health = wait_ready(url, READY_TIMEOUT_S)
        t_ready = sampler.elapsed()
        load_seconds = time.perf_counter() - t_start
        reads_at_attach = int(health.get("reads", 0))
        worker_fresh = reads_at_attach == 0
        if not worker_fresh:
            log(
                f"WARNING: worker already served {reads_at_attach} reads; "
                "'loaded' RAM is not a fresh-load measurement. Restart it and re-run."
            )
        peak_during_load = sampler.max_mb(until=t_ready)
        time.sleep(SETTLE_AFTER_READY_S)
        at_loaded = rss_mb(proc)

        rows: list[dict[str, Any]] = []
        after: dict[int, float] = {}
        for index, photo in enumerate(photos, 1):
            body = photo.read_bytes()
            t0 = time.perf_counter()
            status, resp = http_json("POST", f"{url}/read", body)
            elapsed_ms = (time.perf_counter() - t0) * 1000
            resp = resp if isinstance(resp, dict) and status == 200 else {}
            florence = resp.get("florence") or {}
            crnn = resp.get("crnn") or {}
            current_rss = rss_mb(proc)
            rows.append(
                {
                    "file": photo.name,
                    "value": resp.get("value"),
                    "status": resp.get("status") if status == 200 else f"HTTP_{status}",
                    "confidence": resp.get("confidence"),
                    "florence_liters": florence.get("liters"),
                    "crnn_liters": crnn.get("liters"),
                    "ms": round(elapsed_ms, 1),
                    "worker_ms": resp.get("ms"),
                    "rss_mb": round(current_rss, 1),
                }
            )
            if index in CHECKPOINTS or index == len(photos):
                after[index] = current_rss
            if index % 10 == 0:
                log(f"{index}/{len(photos)} photos, rss={current_rss:.0f} MB")

        log(f"idle {args.idle_seconds}s before the final reading")
        time.sleep(args.idle_seconds)
        idle_rss = rss_mb(proc)
        threads = read_worker_threads(proc, str(args.threads))
        peak_os = os_peak_mb(proc)
        peak_sampled = sampler.max_mb()
    finally:
        sampler.stop()
        if launched is not None:
            if proc.pid != launched.pid:
                # Windows: terminar el lanzador del venv no mata al interprete hijo.
                try:
                    proc.terminate()
                except psutil.Error:
                    pass
            launched.terminate()
            try:
                launched.wait(timeout=15)
            except subprocess.TimeoutExpired:
                launched.kill()
        if stderr_log is not None:
            stderr_log.close()

    latencies = [r["ms"] for r in rows]
    worker_latencies = [r["worker_ms"] for r in rows if isinstance(r["worker_ms"], (int, float))]
    ordered_counts: dict[str, int] = {}
    for r in rows:
        ordered_counts[str(r["status"])] = ordered_counts.get(str(r["status"]), 0) + 1

    def rounded(value: float | None) -> float | None:
        return None if value is None else round(value, 1)

    summary = {
        "mode": "spawn" if args.spawn else "attach",
        "worker_fresh": worker_fresh,
        "reads_at_attach": reads_at_attach,
        "worker_version": health.get("version"),
        "photos": len(rows),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu_model": cpu_model(),
        "cpu_count_logical": psutil.cpu_count(logical=True),
        "cpu_count_physical": psutil.cpu_count(logical=False),
        "python_version": platform.python_version(),
        "ocr_threads": threads,
        # Solo en --spawn: en --pid el worker ya estaba cargado cuando se conecto.
        "load_seconds": round(load_seconds, 2) if args.spawn else None,
        "ram_mb": {
            "peak_during_load": rounded(peak_during_load),
            "loaded": rounded(at_loaded),
            **{f"after_{n}": rounded(after.get(n)) for n in CHECKPOINTS},
            "after_all": rounded(after.get(len(rows))),
            "peak_sampled": rounded(peak_sampled),
            "peak_os": rounded(peak_os),
            "idle": rounded(idle_rss),
        },
        "idle_seconds": args.idle_seconds,
        "latency_ms": {
            "first": round(latencies[0]),
            "median": round(statistics.median(latencies)),
            "p95": round(percentile(latencies, 95)),
            "max": round(max(latencies)),
        },
        "worker_latency_ms": {
            "median": round(statistics.median(worker_latencies)) if worker_latencies else None,
            "max": round(max(worker_latencies)) if worker_latencies else None,
        },
        "status_counts": ordered_counts,
    }

    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    (out_dir / "per_photo.json").write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    with open(out_dir / "per_photo.csv", "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    return summary


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--spawn", action="store_true", help="lanzar y medir un worker local")
    mode.add_argument("--pid", type=int, help="PID de un worker ya corriendo (requiere --url)")
    parser.add_argument("--url", help="URL base del worker en modo --pid")
    parser.add_argument("--photos", default=os.environ.get("OCR_BENCH_PHOTOS", "/photos"), help="carpeta con las fotos")
    parser.add_argument("--out", required=True, help="carpeta de salida")
    parser.add_argument("--threads", type=int, default=int(os.environ.get("OCR_THREADS", "2")))
    parser.add_argument("--models-dir", default=os.environ.get("OCR_MODELS_DIR", str(OCR_DIR / "models")))
    parser.add_argument("--idle-seconds", type=float, default=30.0, help="reposo antes de la lectura final")
    parser.add_argument("--limit", type=int, default=None, help="usar solo las primeras N fotos (pruebas rapidas)")
    args = parser.parse_args(argv)
    if args.pid is not None and not args.url:
        parser.error("--pid requires --url")
    return args


def main(argv: list[str] | None = None) -> None:
    summary = run(parse_args(argv))
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
