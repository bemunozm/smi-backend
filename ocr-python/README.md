# OCR de litros (surtidor) — ensemble ONNX local

Lee el valor `NNN.NNN` de litros de un display 7-segmentos fotografiado en un
surtidor. Corre como un **proceso Python persistente** (`worker.py`),
lanzado una única vez por el backend Node (`src/ocr/ocr.service.ts`, `spawn`
en `onModuleInit`) y reusado entre requests — cargar ambos modelos toma
~0.9s, demasiado para pagarlo por cada foto.

Reemplaza el pipeline anterior (tesseract nativo + localización por
etiqueta impresa, ~6/19 exactas en el test congelado). Este ensemble da
**15/19 exactas, 0 erróneas** (4 a confirmación manual) sobre el mismo test
congelado — ver la sección "Paridad" más abajo. El VPS **ya no necesita
`tesseract-ocr`**.

## Arquitectura

```
worker.py            proceso persistente — protocolo JSON-lines por stdin/stdout
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

### Protocolo del worker (stdin/stdout, JSON-lines)

Request: `{"id": "<opaco>", "path": "<ruta absoluta a un archivo de imagen>"}`

Response: `{"id", "value", "status", "confidence", "florence", "crnn", "ms"}`
(`florence`/`crnn` son la lectura cruda de cada modelo — `{"liters",
"confidence","raw"}` o `null` si la request falló — solo para logging del
lado Node, no llegan al front).

Al arrancar, después de cargar ambos modelos y verificar el sha256 de cada
archivo contra `models.manifest.json`, imprime **una sola línea**
`{"ready": true, "version": "litros-v1"}` antes de aceptar requests. Si la
verificación falla (modelos faltantes/corruptos), el proceso loguea el
error a stderr y termina con exit code 1 **sin imprimir esa línea** — el
backend Node lo interpreta como "murió antes de estar listo" y degrada a
`UNREADABLE` en vez de romper el endpoint (ver `ocr.service.ts`).

Errores de una request individual (imagen no decodificable, etc.) nunca
tumban el proceso: se loguean a stderr y la respuesta para ese `id` es
`{"value": null, "status": "UNREADABLE", "confidence": 0, "florence": null,
"crnn": null, "ms": ...}`.

Todo lo que no sea la línea de ready o una response va a **stderr** —
stdout es sagrado, solo JSON-lines del protocolo.

## Setup local (Windows)

**Python 3.12** (no 3.14 — a la fecha de este pipeline, `tokenizers` no
tiene wheel para 3.14 en este entorno; ver ".env local" abajo):

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

### `.env` local

```
PYTHON_BIN="C:/Users/<user>/AppData/Local/Programs/Python/Python312/python.exe"
OCR_MODELS_DIR="C:/PROYECTOS/SMI-COMPLETO/smi-backend/ocr-python/models"   # opcional, default ya es este
OCR_THREADS=2   # opcional, default 2
```

## Setup VPS (Debian/Ubuntu)

```bash
apt install -y python3 python3-pip   # tesseract-ocr YA NO hace falta
python3 -m pip install -r requirements.txt   # considerar venv
```

**`cwd` del proceso Node — crítico.** `WORKER_SCRIPT_PATH`
(`ocr.service.ts`) y el default de `OCR_MODELS_DIR` (`src/common/config/env.ts`)
se arman con `join(process.cwd(), 'ocr-python', ...)` — dependen del
directorio de trabajo del proceso Node, NO de dónde vive `ocr.service.ts` en
disco. Si el backend se lanza con un `cwd` distinto a la raíz de
`smi-backend`, el worker no se encuentra (o se buscan modelos en la carpeta
equivocada) y el servicio queda degradado en silencio (nunca rompe el boot,
ver el JSDoc de `OcrService`). Al configurar el proceso en el VPS:

- **systemd**: `WorkingDirectory=/ruta/a/smi-backend` explícito en la unit.
- **pm2**: `cwd: '/ruta/a/smi-backend'` en el `ecosystem.config.js` (pm2 no
  hereda el cwd de donde se corre `pm2 start`, sino el que se le declara ahí
  — o el del script apuntado si no se declara, que tampoco es
  necesariamente la raíz del repo).

Si en duda, loguear `process.cwd()` una vez al boot y confirmar que apunta a
la raíz de `smi-backend`, o pasar `OCR_MODELS_DIR` explícito por env para no
depender del default.

Copiar los 6 archivos de `models/` por scp (no van en el repo — ver arriba
la lista de origen) y verificar contra `models.manifest.json`, por ejemplo:

```bash
python3 -c "
import hashlib, json
m = json.load(open('models.manifest.json'))
for e in m['files']:
    h = hashlib.sha256(open(f'models/{e[\"file\"]}', 'rb').read()).hexdigest()
    print(e['file'], 'OK' if h == e['sha256'] else 'MISMATCH')
"
```

(el worker hace exactamente esto mismo al arrancar, así que si falla ahí
también fallará al lanzar el proceso — pero conviene verificar el scp antes
de reiniciar el backend).

### RAM esperada del worker tibio

Medido con `OCR_THREADS=2` sobre una foto real (`tasklist` de Windows desde
afuera del proceso — no se agregó `psutil` a `requirements.txt` solo para
esto):

| Momento | RSS |
|---|---|
| Justo tras la línea `ready` (modelos cargados, 0 inferencias) | ~390 MB |
| Tras la 1ra inferencia | ~570 MB |
| Tibio, en régimen (tras ~3-6 inferencias — ONNX Runtime reserva buffers de arena adicionales las primeras veces, después queda estable) | **~720-725 MB** |

Es decir: contar con **~750 MB** por worker en régimen para dimensionar el
VPS, no los ~390 MB del arranque — el salto de ~390→~720 MB (~1.9x) ocurre
solo, apenas empieza a procesar fotos reales, no es un caso raro.

**Pico transitorio en un restart.** `killWorker()` llama a `child.kill()`
(SIGTERM) y retorna sin esperar a que el proceso realmente termine; el
nuevo worker se lanza por separado tras el backoff
(`RESTART_BACKOFF_MS`, arranca en 1s). Si la baja del proceso viejo tarda
(cleanup de ONNX/buffers grandes, o un SO más lento liberando memoria que
en el benchmark de abajo), hay una ventana donde ambos procesos conviven en
memoria. Medido en Windows local matando un worker tibio (~570 MB, tras 1
sola inferencia) y lanzando el reemplazo casi en el mismo instante
(muestreo cada 15ms): **no se observó solape** — el proceso viejo ya
aparecía muerto en la primera muestra tras el `kill()`. Aun así, para
dimensionar el VPS conviene dejar margen para el peor caso (~2x el RSS
tibio en régimen, ~1.4-1.5 GB) en vez de asumir que la baja siempre es
instantánea como en este benchmark puntual — no se puede garantizar el
mismo comportamiento bajo carga o en un kernel Linux distinto.

## Variables de entorno consumidas por el backend Node

- `PYTHON_BIN`: binario de python usado para lanzar `worker.py` (default
  `python3`; en Windows local, apuntar al `python.exe` de 3.12 con las
  deps — ver arriba).
- `OCR_MODELS_DIR`: carpeta con los 6 archivos de modelo (default
  `<cwd>/ocr-python/models` — ver la nota de `cwd` en "Setup VPS" arriba).
- `OCR_THREADS`: hilos para las sesiones ONNX de Florence + el pool global
  de cv2 (default 2). El CRNN queda fijo en 1 hilo (su config validada más
  rápida, ~41ms en tibio — no configurable a propósito, ver comentario en
  `worker.py`).
  - Como el worker procesa **una request a la vez** (cola serial, ver
    `queueTail` en `ocr.service.ts`), `OCR_THREADS` controla el paralelismo
    DENTRO de una sola inferencia, no cuántas inferencias corren a la vez
    — no hay beneficio en subirlo más allá de los vCPU disponibles.
  - VPS de 2 vCPU: `OCR_THREADS=1` — dejar el otro vCPU libre para el
    event loop de Node (y el resto del backend) durante la ventana de
    ~0.5-0.9s que dura cada inferencia; con `=2` se compite por ambos
    núcleos justo en ese momento.
  - VPS de 4+ vCPU: el default `2` (el valor validado en el benchmark de
    latencia, ver "Paridad" abajo) ya deja margen de sobra para Node y el
    resto de los servicios.
  - No pasarlo por encima del total de vCPU del VPS — sobresuscribir
    hilos más allá de los núcleos físicos solo agrega overhead de
    scheduling, no acelera la inferencia.

## Tests

```bash
cd ocr-python
py -3.12 -m pytest
```

Son puramente lógicos (regex, `parse_output`, la regla de ensemble, el CTC
greedy-decode con logits sintéticos, el cross-check de $, la tabla de
orientación EXIF) — no requieren los modelos ni onnxruntime cargado, así que
corren en CI sin los archivos de `models/`.

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
