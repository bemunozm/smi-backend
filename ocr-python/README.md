# OCR de litros (surtidor) — ensemble ONNX local

Lee el valor `NNN.NNN` de litros de un display 7-segmentos fotografiado en un
surtidor. Corre como un **servicio HTTP aparte** (`worker.py`, solo stdlib de
Python): los modelos ONNX se cargan una vez al arrancar (~0.9s, demasiado para
pagarlo por cada foto) y el backend Node (`src/ocr/ocr.service.ts`) le pega
por HTTP en `OCR_WORKER_URL`. No es un proceso hijo del backend: su ciclo de
vida lo gobierna Docker (ver "Despliegue con Docker").

Reemplaza el pipeline anterior (tesseract nativo + localización por
etiqueta impresa, ~6/19 exactas en el test congelado). Este ensemble da
**15/19 exactas, 0 erróneas** (4 a confirmación manual) sobre el mismo test
congelado — ver la sección "Paridad" más abajo. El VPS **ya no necesita
`tesseract-ocr`**.

## Arquitectura

```
worker.py            servidor HTTP (stdlib): GET /health, POST /read
litros/
  florence.py         Florence-2-base fine-tuneado (ONNX int8): vision+encoder+decoder
  crnn.py              CRNN-CTC + localizador de paneles (puro OpenCV) + EXIF explícito
  ensemble.py          regla de acuerdo -> CONFIRMED/REVIEW/UNREADABLE
models/               (gitignored) los 6 archivos de modelo, ver "Setup" abajo
models.manifest.json  versión + tamaño + sha256 de cada archivo esperado en models/
tests/                pytest — solo lógica pura, no requieren los modelos
```

### Ensemble (regla de acuerdo)

- **CONFIRMED**: Florence y CRNN leen lo mismo (no nulo) -> `value` = esa
  lectura, `confidence` = el mínimo de las dos confianzas.
- **REVIEW**: difieren, o solo uno de los dos leyó algo -> `value` = la
  lectura de Florence (primaria), o la de CRNN si Florence dio null;
  `confidence` = la confianza propia de esa lectura.
- **UNREADABLE**: ambos dan null -> `value: null`, `confidence: 0`.

### Protocolo del worker (HTTP)

`GET /health`
- **503** `{"ready": false}` mientras verifica el sha256 de los modelos y los
  carga. El servidor HTTP arranca ANTES de eso, así que el healthcheck de
  Docker recibe un 503 en vez de una conexión rechazada.
- **200** `{"ready": true, "version": "litros-v1", "reads": N, "uptime_s": S}`
  cuando está listo. `reads` cuenta las lecturas procesadas desde que
  arrancó (el benchmark lo usa para saber si el worker está "fresco").
- Nunca toma el lock de lectura: responde aunque haya una inferencia en curso.

`POST /read` — el body son los **bytes crudos de la imagen** (sin multipart;
tope de 8 MB, el mismo del controller). El worker los escribe a un temporal
propio, llama a los lectores con esa ruta y borra el temporal en `finally`.
- **200** `{"value", "status", "confidence", "florence", "crnn", "ms"}`
  (`florence`/`crnn` son la lectura cruda de cada modelo — `{"liters",
  "confidence","raw"}` o `null` si la lectura falló — solo para logging; el
  backend usa `value`/`status`/`confidence`).
- Un error de la lectura misma (imagen no decodificable, etc.) **no** es un
  error HTTP: responde 200 con `{"value": null, "status": "UNREADABLE",
  "confidence": 0, "florence": null, "crnn": null, ...}` y el proceso sigue.
- **400** body ausente o vacío, **413** body sobre el tope, **503** si los
  modelos todavía no cargaron.

Las lecturas se **serializan** con un `threading.Lock` (una inferencia a la
vez sobre las sesiones ONNX compartidas); el backend además las encola en
serie y degrada a `UNREADABLE` ante cualquier fallo (conexión rechazada, 503,
timeout de 15 s contado desde que la request entra a la cola, cuerpo inválido).

**Vigilante interno.** Si UNA lectura pasa de `OCR_READ_WATCHDOG_SECONDS`
(default 30), el proceso sale con código 70 (`os._exit`). Es lo que reemplaza
al "matar y relanzar" que antes hacía Node: `restart: unless-stopped` de
Docker lo relanza, y el compose sin swarm **no** reinicia un contenedor solo
por estar `unhealthy`.

**Arranque fallido.** Modelos faltantes/corruptos (sha256 o tamaño distinto
al de `models.manifest.json`) terminan el proceso con código 1 tras loguearlo
a stderr; `/health` nunca llegó a decir `ready` y el backend degrada.

Todo log/diagnóstico va a **stderr**.

## Setup local (Windows)

**Python 3.12** (no 3.14 — a la fecha de este pipeline, `tokenizers` no
tiene wheel para 3.14 en este entorno):

```bash
py -3.12 -m pip install -r requirements.txt
```

Copiar los modelos (no van en git, ver `.gitignore`) a `ocr-python/models/`:

- De `smi-frontend/scratchpad/ocr-train/florence-ft/onnx/`: `vision.int8.onnx`,
  `encoder.int8.onnx`, `decoder.int8.onnx`, `tokenizer.json`.
- De `smi-frontend/scratchpad/ocr-train/crnn/`: `crnn.onnx`.
- `litros_config.json`: **NO** es una copia directa del de
  `florence-ft/onnx/` — esta versión le agrega la clave `"topsq_ratio": 1.2`
  (movida ahí desde una constante de módulo en el runtime original). Ver el
  archivo ya commiteado como referencia si hace falta regenerarlo.

El worker verifica cada archivo contra `models.manifest.json` (sha256 +
tamaño) al arrancar — si copiaste algo distinto, falla ahí con un mensaje
claro en vez de silenciosamente dar lecturas raras.

### Correr el worker en local

```bash
cd ocr-python
OCR_MODELS_DIR="C:/ruta/a/ocr-python/models" python worker.py   # default: ./models
```

Escucha en `0.0.0.0:8010` (`OCR_HOST`/`OCR_PORT`). El backend lo encuentra
solo en `http://localhost:8010` (default de `OCR_WORKER_URL`). Si falta Python,
las dependencias o los modelos, el backend arranca igual y las lecturas
degradan a `UNREADABLE`.

## Despliegue con Docker (VPS Linux ARM64)

Las imágenes se construyen **en el VPS** (ARM nativo); ver "Stack y despliegue
con Docker" en el README del backend para el stack completo. Este servicio:

- `ocr-python/Dockerfile`: `python:3.12-slim-bookworm`, venv con
  `requirements.txt` (todas las ruedas tienen variante `manylinux aarch64` para
  cp312; **no Alpine**, onnxruntime no publica ruedas musl), usuario no root.
  Targets `prod` (default) y `bench` (suma `psutil` y el benchmark).
- Los **modelos no van en la imagen**: se copian al VPS por scp y se montan de
  solo lectura en `/models` (`OCR_MODELS_HOST_DIR`, default
  `./ocr-python/models`). El worker verifica su sha256 al arrancar.
- Sin puertos publicados: solo la red interna del compose.

Copiar los 6 archivos de `models/` (ver arriba la lista de origen) y verificar
contra `models.manifest.json` antes de levantar, por ejemplo:

```bash
python3 -c "
import hashlib, json
m = json.load(open('models.manifest.json'))
for e in m['files']:
    h = hashlib.sha256(open(f'models/{e[\"file\"]}', 'rb').read()).hexdigest()
    print(e['file'], 'OK' if h == e['sha256'] else 'MISMATCH')
"
```

(el worker hace exactamente esto al arrancar; verificarlo antes ahorra un ciclo
de contenedor reiniciándose).

### RAM esperada del worker tibio

Medida desde afuera del proceso con `bench/ocr_ram_bench.py` (RSS vía psutil,
`OCR_THREADS=2`, las 106 fotos de `_inbox/total_surtidor`):

| Momento | Windows nativo | Docker x86 (WSL2) | ARM64, 1.5 CPU | ARM64, 2.0 CPU |
|---|---|---|---|---|
| Modelos recién cargados (0 lecturas) | 390 MB | 479 MB | 426 MB | 477 MB |
| Tras la 1ª foto | 574 MB | 677 MB | 607 MB | 658 MB |
| Tras la 3ª | 726 MB | 838 MB | 735 MB | 787 MB |
| Tras la 20ª / todas | 729 MB | 841 MB | 738 MB | 790 MB |
| Pico (SO) | 747 MB | 841 MB | 738 MB | 790 MB |

Tiempo por foto (worker tibio, lecturas en serie):

| | Windows nativo | Docker x86 (WSL2) | ARM64, 1.5 CPU | ARM64, 2.0 CPU |
|---|---|---|---|---|
| 1ª foto | 700 ms | 883 ms | 2058 ms | 1494 ms |
| Mediana | 567 ms | 687 ms | 1997 ms | 1440 ms |
| p95 | 632 ms | 997 ms | 2246 ms | 1645 ms |
| Máximo | 700 ms | 1620 ms | 2317 ms | 1746 ms |

ARM64 = Hetzner CAX21 (Ampere Neoverse-N1, 4 vCPU), Docker, `OCR_THREADS=2`.
Con 1.5 CPU el cgroup frenaba el 93% de los periodos (2 hilos ONNX contra 1.5
CPU de cuota); con 2.0 baja al 33% y la mediana cae ~28%, a cambio de ~50 MB.
El compose de producción usa 2.0.

ONNX Runtime reserva buffers de arena adicionales las primeras 3-6 lecturas y
después queda estable: dimensionar con el valor **en régimen**, no con el de
recién cargado. El salto es ~1.9x y ocurre solo.

**Lecturas iguales entre plataformas.** Las 4 corridas dan 96 `CONFIRMED`, 10
`REVIEW` y 0 `UNREADABLE`. Foto por foto, 105 de 106 son idénticas (valor,
estado y confianza); el CRNN es idéntico en todas. La única diferencia es una
lectura de Florence (int8) en una foto que en todas las plataformas queda en
`REVIEW` porque el CRNN no coincide: ONNX Runtime usa kernels int8 distintos en
x86 y en ARM, y eso puede cambiar un dígito dudoso. Ninguna lectura confirmada
cambia.

**Reinicios.** Antes, Node mataba y relanzaba el worker, con un posible
solape de dos procesos de ~720 MB. Ahora un reinicio es el MISMO contenedor
que sale (vigilante o crash) y Docker lo relanza: no conviven dos workers. El
límite del contenedor es 1.5G.

## Benchmark

`bench/ocr_ram_bench.py` mide RAM física (RSS, muestreo cada 50 ms más el pico
del SO: `peak_wset` en Windows, `VmHWM` en Linux) y tiempo por foto
(primera, mediana, p95, máximo). Requiere `psutil` (la imagen `bench` ya lo
trae; en local: `pip install psutil==7.2.2`).

```bash
# Local: lanza el worker en un puerto libre y lo mide
python bench/ocr_ram_bench.py --spawn --photos <carpeta> --out <salida>

# Contra un worker ya corriendo (modo del contenedor ocr-bench)
python bench/ocr_ram_bench.py --pid <PID> --url http://ocr-worker:8010 --photos <carpeta> --out <salida>

# En el VPS: reinicia el worker, espera healthy, corre el bench
bash scripts/bench-ocr.sh        # salida en ./bench-results/<timestamp>/
```

En modo `--pid` verifica que el worker esté **fresco** (`reads` = 0 en
`/health`); si no, `summary.json` trae `worker_fresh: false` y el momento
"modelos recién cargados" no es válido. Salida: `summary.json`,
`per_photo.csv` y `per_photo.json`. `bench/compare_runs.py <a> <b>` compara
dos corridas por foto (estados y fotos con `value`/`status` distintos), útil
para validar ARM contra x86.

## Variables de entorno

Del **worker** (las fija `docker-compose.prod.yml`; en local, el entorno del
proceso):

- `OCR_MODELS_DIR`: carpeta con los 6 archivos de modelo (default
  `<ocr-python>/models`; en Docker, `/models`).
- `OCR_THREADS`: hilos para las sesiones ONNX de Florence + el pool global de
  cv2 (default 2). El CRNN queda fijo en 1 hilo (su config validada más
  rápida, ~41ms en tibio — no configurable a propósito).
  - Como las lecturas van en serie, `OCR_THREADS` controla el paralelismo
    DENTRO de una inferencia, no cuántas corren a la vez; no tiene sentido
    pasarlo del total de vCPU.
  - VPS de 2 vCPU: `OCR_THREADS=1` para dejar un núcleo libre al backend. Con
    4+ vCPU (el CAX21 tiene 4), el default 2 deja margen de sobra.
- `OCR_HOST` / `OCR_PORT`: dónde escucha (default `0.0.0.0` / `8010`).
- `OCR_READ_WATCHDOG_SECONDS`: tope de una lectura antes de que el proceso
  salga para que Docker lo reinicie (default 30).

Del **backend**: solo `OCR_WORKER_URL` (default `http://localhost:8010`; en
Docker, `http://ocr-worker:8010`).

## Tests

```bash
cd ocr-python
python -m pip install -r requirements-dev.txt   # pytest (versión fijada)
python -m pytest
```

Son puramente lógicos (regex, `parse_output`, la regla de ensemble, el CTC
greedy-decode con logits sintéticos, el cross-check de $, la tabla de
orientación EXIF) más el servidor HTTP del worker con lectores falsos
(`tests/test_worker_http.py`: health antes/después de estar listo, lectura
OK, error de lectura → UNREADABLE, 400/413, temporal borrado, vigilante) — no
requieren los modelos, así que corren en CI sin los archivos de `models/`.

## Paridad (test congelado, 19 fotos)

Corriendo el worker sobre las 19 fotos de
`smi-frontend/scratchpad/ocr-dataset/split.json` ->
`splits_dedup_md5.test` (ground truth en `labels.csv`, columna `liters`):

**15 CONFIRMED, las 15 correctas. 0 CONFIRMED erróneas. 4 REVIEW. 0
UNREADABLE.** Coincide exactamente con la referencia de investigación
(`smi-frontend/scratchpad/ocr-train/test_results.json`, columna `ensemble`).

Latencia tibia (proceso ya cargado, mediana sobre 18 requests excluyendo la
primera): ~610ms por foto en la máquina de desarrollo (Python 3.12, 2
hilos). Ver el reporte de la tarea para la tabla completa.

## Limpieza hecha en este port (no reintroducir)

Portado desde `smi-frontend/scratchpad/ocr-train/{florence-ft,crnn}/`
(carpeta de investigación, gitignored) — se dejó afuera a propósito:

- `TorchLitros` y cualquier rama `torch`/`transformers` (`florence.py` es
  ONNX-only).
- Todo el código de entrenamiento/dataset/augmentation/métricas de
  `ftcommon.py` (dataset access, `augment`, `digit_acc`, `summarize`, etc.)
  y el equivalente del lado CRNN (`train.py`, `synth.py`, `gen_synth.py`,
  `build_real.py`, `common.py` del dataset).
- Rutas absolutas hardcodeadas (`SCRATCH`, `DATASET_DIR`, `TESSERACT_BIN` en
  los módulos de investigación).
- `sys.path.insert` (el runtime original en `crnn/predict.py` lo usaba para
  poder correr como script suelto) — acá `litros/` es un paquete propio con
  imports normales, y `worker.py` lo importa como tal.
- `cv2.setNumThreads(1)` a nivel de import (estaba en `ftcommon.py` línea
  30) — centralizado una sola vez en `worker.py::main()`.
- Código de debug/`psutil` (`predict.py`'s `PREDICT_MEM`).
- `open()` sin cerrar (`json.load(open(...))`) — todo pasa por `with open(...)`.
- La ausencia total de manejo de EXIF en el pipeline CRNN original — ver
  `litros/crnn.py::decode_image_exif_safe`.
