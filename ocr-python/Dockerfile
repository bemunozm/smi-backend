# Worker OCR de litros (Python + ONNX Runtime). Multi-arch: todas las ruedas
# de requirements.txt tienen variante manylinux aarch64 (cp312), asi que se
# construye en el VPS ARM64 igual que en un PC x86.
#
# Debian slim y NO Alpine: onnxruntime no publica ruedas musl.
#
# Contexto de build: esta carpeta (ocr-python/). Los modelos (~300MB) NO se
# hornean: se montan de solo lectura en /models y el worker verifica su sha256
# contra models.manifest.json al arrancar.
#
# Targets:
#   prod   imagen de produccion (default).
#   bench  = base + psutil + el benchmark; para medir RAM del worker corriendo
#          (docker-compose.bench.yml). psutil no va en la imagen de produccion.

# Las ruedas son binarias (sin compilar nada), asi que el venv se arma en una
# etapa aparte solo para que pip y su cache no lleguen a la imagen final.
FROM python:3.12-slim-bookworm AS builder
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
COPY requirements.txt .
RUN /opt/venv/bin/pip install -r requirements.txt

FROM python:3.12-slim-bookworm AS base
# Sin paquetes apt extra: se verifico que `import cv2, onnxruntime, tokenizers,
# PIL, numpy` carga en python:3.12-slim-bookworm con las ruedas de
# requirements.txt (opencv-python-headless no necesita libglib/libGL).
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin ocr
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    OCR_MODELS_DIR=/models \
    OCR_HOST=0.0.0.0 \
    OCR_PORT=8010
WORKDIR /app
COPY worker.py models.manifest.json ./
COPY litros ./litros
EXPOSE 8010

FROM base AS bench
USER root
RUN pip install --no-cache-dir psutil==7.2.2
COPY bench ./bench
# Mismo usuario que el worker: asi psutil tambien lee su entorno
# (OCR_THREADS) por /proc/<pid>/environ. `scripts/bench-ocr.sh` lo pisa con
# --user para que la salida quede a nombre de quien invoca; en ese caso el
# bench cae a la env OCR_THREADS, que compose le pasa igual.
USER ocr
CMD ["python", "bench/ocr_ram_bench.py", "--help"]

FROM base AS prod
USER ocr
CMD ["python", "worker.py"]
