#!/usr/bin/env bash
# Mide RAM y tiempo por foto del worker OCR en este servidor (pensado para el
# VPS ARM64) y deja la salida en ./bench-results/<timestamp>/.
#
# Uso (desde la raiz del repo, con el stack de produccion levantado):
#   bash scripts/bench-ocr.sh
#
# Variables (todas opcionales):
#   COMPOSE_PROJECT     proyecto de compose (default: smi)
#   OCR_BENCH_PHOTOS_DIR  carpeta con las fotos (default: ./_inbox/total_surtidor)
#   HEALTH_TIMEOUT_S    espera maxima a que el worker quede healthy (default: 240)
#
# El worker se REINICIA antes de medir: el momento "modelos recien cargados"
# solo es valido si no ha procesado ninguna foto.
set -euo pipefail

cd "$(dirname "$0")/.."

project="${COMPOSE_PROJECT:-smi}"
health_timeout="${HEALTH_TIMEOUT_S:-240}"
compose=(docker compose -f docker-compose.prod.yml -f docker-compose.bench.yml -p "$project")

timestamp="$(date +%Y%m%d-%H%M%S)"
out_dir="./bench-results/${timestamp}"
mkdir -p "$out_dir"
export OCR_BENCH_OUT_DIR="$out_dir"

echo "[bench-ocr] reiniciando ocr-worker (proyecto: ${project})"
"${compose[@]}" restart ocr-worker

echo "[bench-ocr] esperando a que ocr-worker quede healthy (max ${health_timeout}s)"
container_id="$("${compose[@]}" ps -q ocr-worker)"
deadline=$((SECONDS + health_timeout))
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$container_id")" = "healthy" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "[bench-ocr] ocr-worker no quedo healthy a tiempo" >&2
    "${compose[@]}" logs --tail 30 ocr-worker >&2
    exit 1
  fi
  sleep 2
done

echo "[bench-ocr] corriendo el benchmark"
# --user: los archivos de salida quedan a nombre del usuario que invoca, no de root.
"${compose[@]}" run --rm --user "$(id -u):$(id -g)" ocr-bench

echo "[bench-ocr] listo: ${out_dir}/summary.json"
