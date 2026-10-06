"""Servidor HTTP del OCR de litros (solo stdlib).

Corre como un servicio aparte del backend Node (`src/ocr/ocr.service.ts` le
pega por HTTP). Los modelos ONNX se cargan UNA vez al arrancar: cargarlos
toma ~0.9s, demasiado para pagarlo por request.

Endpoints:
    GET  /health  503 {"ready": false} mientras se verifican/cargan los
                  modelos; 200 {"ready": true, "version", "reads",
                  "uptime_s"} cuando esta listo. Nunca toma el lock de
                  lectura: responde aunque haya una inferencia en curso.
    POST /read    el body son los bytes crudos de la imagen (tope
                  `MAX_BODY_BYTES`). Responde 200 con
                  {"value", "status", "confidence", "florence", "crnn", "ms"}.
                  400 si el body falta o esta vacio, 413 si excede el tope,
                  503 si los modelos todavia no cargaron. Un fallo de la
                  lectura misma (imagen no decodificable, etc.) es 200 con
                  UNREADABLE: nunca tumba el proceso.

Reglas de diseno:
    - Las lecturas se serializan con un `threading.Lock`: las sesiones ONNX
      se comparten y una inferencia a la vez es lo que se valido.
    - Vigilante: si UNA lectura pasa de `OCR_READ_WATCHDOG_SECONDS`, el
      proceso sale con codigo distinto de 0 (`os._exit`). La politica
      `restart` de Docker lo relanza; compose sin swarm no reinicia un
      contenedor solo por estar `unhealthy`, asi que esta es la unica via de
      recuperarse de una inferencia colgada.
    - Todo log/diagnostico va a stderr.
    - Un error al arrancar (modelos faltantes/corruptos) termina con exit 1.

Configuracion por env:
    OCR_MODELS_DIR            carpeta con los 6 archivos de modelo
                              (default "<este dir>/models").
    OCR_THREADS               hilos de las sesiones ONNX de Florence y del
                              pool de cv2 (default 2). El CRNN queda fijo en
                              1 hilo: es su config validada mas rapida
                              (~41ms tibio) y el modelo es tan chico que mas
                              hilos solo agregan overhead de scheduling.
    OCR_HOST / OCR_PORT       donde escucha (default 0.0.0.0 / 8010).
    OCR_READ_WATCHDOG_SECONDS tope de una lectura antes de salir (default 30).
"""
from __future__ import annotations

import hashlib
import json
import os
import signal
import sys
import tempfile
import threading
import time
import traceback
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST_PATH = os.path.join(HERE, "models.manifest.json")

# Mismo tope que el multer del controller (`OcrController`): el backend nunca
# manda mas que esto, asi que un body mayor es un cliente que no es el backend.
MAX_BODY_BYTES = 8 * 1024 * 1024
DEFAULT_THREADS = 2
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8010
DEFAULT_WATCHDOG_SECONDS = 30.0
# Codigo de salida del vigilante: distinto de 0 para que `restart:
# unless-stopped` lo relance, y distinto de 1 (fallo de arranque) para poder
# distinguirlos en los logs de Docker.
WATCHDOG_EXIT_CODE = 70

ReadFn = Callable[[str], dict[str, Any]]


def log(msg: str) -> None:
    print(f"[ocr-worker] {msg}", file=sys.stderr, flush=True)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        log(f"invalid {name}={raw!r}, using default {default}")
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        log(f"invalid {name}={raw!r}, using default {default}")
        return default
    if value <= 0:
        log(f"invalid {name}={raw!r} (must be > 0), using default {default}")
        return default
    return value


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


def build_reader(florence, crnn_rec) -> ReadFn:
    """Arma la funcion de lectura sobre los dos modelos ya cargados.

    Los lectores reciben una RUTA de archivo (no bytes), asi que el llamador
    (`OcrState.read_image`) es quien materializa el temporal.
    """
    from litros import crnn, ensemble

    def read(path: str) -> dict[str, Any]:
        f = florence.read(path)
        c = crnn.read(path, crnn_rec)
        result = ensemble.combine(
            ensemble.ReaderResult(f.liters, f.confidence),
            ensemble.ReaderResult(c.liters, c.confidence),
        )
        return {
            "value": result.value,
            "status": result.status,
            "confidence": result.confidence,
            "florence": {"liters": f.liters, "confidence": f.confidence, "raw": f.raw},
            "crnn": {"liters": c.liters, "confidence": c.confidence, "raw": c.raw},
        }

    return read


class OcrState:
    """Estado compartido entre los hilos del servidor y el vigilante."""

    def __init__(
        self,
        watchdog_seconds: float = DEFAULT_WATCHDOG_SECONDS,
        max_body_bytes: int = MAX_BODY_BYTES,
    ) -> None:
        self.watchdog_seconds = watchdog_seconds
        self.max_body_bytes = max_body_bytes
        self.version: str | None = None
        self.reader: ReadFn | None = None
        self.reads = 0
        self.started_at = time.monotonic()
        self.read_lock = threading.Lock()
        # Inicio (monotonic) de la lectura en curso, o None. Lo escribe solo
        # quien tiene `read_lock`; el vigilante lo lee sin lock (asignacion
        # atomica de una referencia en CPython).
        self.read_started_at: float | None = None

    @property
    def ready(self) -> bool:
        return self.reader is not None

    def mark_ready(self, version: str, reader: ReadFn) -> None:
        self.version = version
        self.reader = reader

    def health(self) -> dict[str, Any]:
        if not self.ready:
            return {"ready": False}
        return {
            "ready": True,
            "version": self.version,
            "reads": self.reads,
            "uptime_s": round(time.monotonic() - self.started_at, 1),
        }

    def read_image(self, data: bytes) -> dict[str, Any]:
        """Lee una imagen en memoria. Serializado; nunca lanza por la lectura."""
        reader = self.reader
        if reader is None:
            raise RuntimeError("models not loaded")

        with self.read_lock:
            t0 = time.perf_counter()
            self.read_started_at = time.monotonic()
            tmp_path: str | None = None
            try:
                # La extension no importa: ambos lectores decodifican por
                # contenido (cv2.imdecode / PIL), no por nombre.
                with tempfile.NamedTemporaryFile(prefix="smi-ocr-", suffix=".img", delete=False) as tmp:
                    tmp_path = tmp.name
                    tmp.write(data)
                resp = reader(tmp_path)
            except Exception:
                log(f"read failed:\n{traceback.format_exc()}")
                resp = {
                    "value": None,
                    "status": "UNREADABLE",
                    "confidence": 0.0,
                    "florence": None,
                    "crnn": None,
                }
            finally:
                if tmp_path is not None:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        log(f"could not remove temp file {tmp_path}")
                self.read_started_at = None
                self.reads += 1
            resp["ms"] = round((time.perf_counter() - t0) * 1000, 1)
            return resp


class Watchdog:
    """Sale del proceso si una lectura excede `state.watchdog_seconds`."""

    def __init__(
        self,
        state: OcrState,
        exit_fn: Callable[[int], Any] = os._exit,
        poll_seconds: float = 1.0,
    ) -> None:
        self._state = state
        self._exit_fn = exit_fn
        self._poll_seconds = poll_seconds

    def check(self, now: float | None = None) -> bool:
        """Devuelve True (y dispara la salida) si hay una lectura pasada de tiempo."""
        started = self._state.read_started_at
        if started is None:
            return False
        elapsed = (time.monotonic() if now is None else now) - started
        if elapsed <= self._state.watchdog_seconds:
            return False
        log(
            f"watchdog: a read has been running for {elapsed:.1f}s "
            f"(> {self._state.watchdog_seconds}s), exiting so the container restarts"
        )
        self._exit_fn(WATCHDOG_EXIT_CODE)
        return True

    def start(self) -> threading.Thread:
        def loop() -> None:
            while True:
                time.sleep(self._poll_seconds)
                self.check()

        thread = threading.Thread(target=loop, name="ocr-watchdog", daemon=True)
        thread.start()
        return thread


def make_handler(state: OcrState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "smi-ocr-worker"

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _reject(self, status: int, error: str) -> None:
            # El body de la request puede quedar sin leer: cerrar la conexion
            # evita que sus bytes se interpreten como la siguiente request.
            self.close_connection = True
            self._send_json(status, {"error": error})

        def do_GET(self) -> None:
            if self.path != "/health":
                self._send_json(404, {"error": "not found"})
                return
            self._send_json(200 if state.ready else 503, state.health())

        def do_POST(self) -> None:
            if self.path != "/read":
                self._reject(404, "not found")
                return
            if not state.ready:
                self._reject(503, "models not loaded yet")
                return

            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                self._reject(400, "Content-Length required")
                return
            if length <= 0:
                self._reject(400, "empty body")
                return
            if length > state.max_body_bytes:
                self._reject(413, f"body exceeds {state.max_body_bytes} bytes")
                return

            data = self.rfile.read(length)
            if len(data) != length:
                self._reject(400, "truncated body")
                return

            self._send_json(200, state.read_image(data))

        def log_message(self, format: str, *args: Any) -> None:
            # El healthcheck de Docker pega cada pocos segundos: sin esto
            # llenaria stderr. Los eventos que importan se loguean a mano.
            return

    return Handler


def make_server(state: OcrState, host: str, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(state))
    server.daemon_threads = True
    return server


def main() -> None:
    threads = _env_int("OCR_THREADS", DEFAULT_THREADS)
    host = os.environ.get("OCR_HOST") or DEFAULT_HOST
    port = _env_int("OCR_PORT", DEFAULT_PORT)
    models_dir = os.environ.get("OCR_MODELS_DIR") or os.path.join(HERE, "models")
    watchdog_seconds = _env_float("OCR_READ_WATCHDOG_SECONDS", DEFAULT_WATCHDOG_SECONDS)

    state = OcrState(watchdog_seconds=watchdog_seconds)
    server = make_server(state, host, port)
    stop = threading.Event()

    # Como PID 1 en un contenedor, Python no tiene handler por defecto para
    # SIGTERM y `docker stop` esperaria el timeout completo antes de SIGKILL.
    def request_stop(_signum: int, _frame: object) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    # El servidor HTTP arranca ANTES de cargar los modelos para que /health
    # responda 503 durante la verificacion sha256 (~300MB) en vez de
    # rechazar la conexion.
    threading.Thread(target=server.serve_forever, name="ocr-http", daemon=True).start()
    log(f"listening on {host}:{port}")

    import cv2

    cv2.setNumThreads(threads)

    log(f"starting: models_dir={models_dir} threads={threads} watchdog={watchdog_seconds}s")
    manifest = _load_manifest()
    _verify_models(models_dir, manifest)
    log("model files verified against manifest (sha256 ok)")

    from litros.crnn import CrnnRecognizer
    from litros.florence import FlorenceReader

    florence = FlorenceReader(models_dir, threads=threads)
    crnn_rec = CrnnRecognizer(os.path.join(models_dir, "crnn.onnx"), threads=1)
    log(f"models loaded (version={manifest['version']})")

    state.mark_ready(manifest["version"], build_reader(florence, crnn_rec))
    Watchdog(state).start()
    log("ready")

    stop.wait()
    log("stop requested, shutting down")
    server.shutdown()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Un fallo de arranque (modelos faltantes/corruptos, manifest roto)
        # termina el proceso con 1: el contenedor se reinicia y /health nunca
        # llego a decir ready.
        log("fatal error, exiting:\n" + traceback.format_exc())
        sys.exit(1)
