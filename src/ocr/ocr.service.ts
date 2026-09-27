/**
 * OCR server-side de la lectura de litros del display 7-segmentos de un
 * surtidor, a partir de una foto. Cliente de un proceso Python
 * PERSISTENTE (`ocr-python/worker.py`) que corre un ensemble local de dos
 * modelos ONNX (Florence-2-base fine-tuneado + CRNN-CTC) — ver ese archivo
 * y `ocr-python/README.md` para el pipeline y el setup del VPS.
 *
 * Precisión validada sobre el test congelado (19 fotos): 15/19 exactas,
 * 0 erróneas (4 a confirmación manual) — ver `ocr-python/README.md`
 * sección "Paridad". A diferencia del pipeline anterior, el front NO recibe
 * confianza por dígito: recibe un `status` de acuerdo entre los dos modelos
 * (`CONFIRMED`/`REVIEW`/`UNREADABLE`) y decide autollenar o pedir revisión
 * en base a eso, no en base a un desglose por dígito (que este pipeline no
 * produce).
 *
 * Por qué un proceso persistente y no `execFile` por request (como el
 * pipeline anterior): cargar los dos modelos ONNX toma ~0.9s — pagar eso en
 * cada foto sería inaceptable. En `onModuleInit` se lanza el worker una
 * sola vez (protocolo JSON-lines por stdin/stdout, cola serial: una
 * request en vuelo a la vez) y se reusa para toda la vida del proceso Nest,
 * con auto-restart (backoff) si muere o se cuelga.
 *
 * Backpressure: como el worker es serial, una ráfaga de uploads
 * concurrentes se encolaría sin límite si no fuera por
 * `MAX_PENDING_REQUESTS` — pasado ese cupo de requests aceptadas (encoladas
 * + en vuelo) sin resolver, las nuevas se degradan de inmediato sin escribir
 * el temporal ni encolar (ver `readFuelValueFrom`).
 *
 * Notas de deploy (VPS):
 * - Requiere `python3` + `ocr-python/requirements.txt` instalado
 *   (`onnxruntime`, `tokenizers`, `numpy`, `opencv-python-headless`,
 *   `pillow`) — YA NO requiere `tesseract-ocr`. Configurable por env
 *   `PYTHON_BIN`/`OCR_MODELS_DIR`/`OCR_THREADS` (ver
 *   `src/common/config/env.ts`).
 * - Los modelos (`ocr-python/models/`, ~300MB) NO van en git — se copian a
 *   mano/por scp (ver `ocr-python/README.md` y `models.manifest.json`,
 *   este sí committeado con los sha256 esperados).
 * - Si python/los modelos faltan, el worker no llega a imprimir la línea
 *   de "ready" (falla la verificación sha256 al arrancar) y este servicio
 *   queda degradado — nunca bloquea el boot de Nest ni devuelve 500: las
 *   requests de OCR resuelven a `{ value: null, status: 'UNREADABLE',
 *   confidence: 0 }` y el usuario tipea a mano.
 */
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline';

import { env } from '../common/config/env';

export type OcrFuelReadingStatus = 'CONFIRMED' | 'REVIEW' | 'UNREADABLE';

export interface OcrFuelReadingResult {
  value: string | null;
  status: OcrFuelReadingStatus;
  confidence: number;
}

const DEGRADED_RESULT: OcrFuelReadingResult = {
  value: null,
  status: 'UNREADABLE',
  confidence: 0,
};

const WORKER_SCRIPT_PATH = join(process.cwd(), 'ocr-python', 'worker.py');
/** Extensión de fallback para el archivo temporal cuando la foto subida no trae una reconocible. */
const DEFAULT_EXTENSION = '.jpg';
/**
 * Tibio (modelos ya cargados) el ensemble responde en ~0.5-0.9s en la
 * máquina de desarrollo (ver benchmark en `ocr-python/README.md`). 10s da
 * margen generoso sin dejar una request colgada indefinidamente si el
 * proceso python se cuelga — y dispara un restart del worker (ver
 * `restartWorker`), no solo la degradación de esa request.
 */
const REQUEST_TIMEOUT_MS = 10_000;
/** Backoff acotado entre reintentos de lanzar el worker (ms); el último valor se repite. */
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000];
/**
 * Tope de requests ACEPTADAS (encoladas detrás de `queueTail` + la que está
 * en vuelo con el worker) que todavía no resolvieron. El worker procesa una
 * request a la vez (cola serial), así que sin este tope una ráfaga de
 * uploads concurrentes (varios choferes subiendo fotos a la vez) encolaría
 * sin límite — cada request esperando cada vez más, hasta el timeout de
 * `REQUEST_TIMEOUT_MS` cada una. Mejor degradar de inmediato (sin escribir
 * el temporal ni encolar) las que exceden el cupo: el usuario tipea a mano
 * en vez de esperar 10s para lo mismo.
 */
const MAX_PENDING_REQUESTS = 6;

interface PendingRequest {
  resolve: (result: OcrFuelReadingResult) => void;
  timeoutHandle: NodeJS.Timeout;
}

@Injectable()
export class OcrService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OcrService.name);

  private worker: ChildProcessWithoutNullStreams | null = null;
  private stdoutInterface: ReadlineInterface | null = null;
  private ready = false;
  private destroyed = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  /**
   * Cola serial: el worker python procesa una request a la vez (loop
   * síncrono sobre stdin), así que en vez de mandarle varias líneas de
   * golpe cuando el backend recibe uploads concurrentes, cada
   * `readFuelValueFrom` encola detrás de la anterior — se manda recién
   * cuando la previa ya resolvió.
   */
  private queueTail: Promise<OcrFuelReadingResult> =
    Promise.resolve(DEGRADED_RESULT);
  /** Requests aceptadas sin resolver todavía (encoladas o en vuelo) — ver `MAX_PENDING_REQUESTS`. */
  private pendingCount = 0;

  onModuleInit(): void {
    this.startWorker();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.killWorker();
  }

  async readFuelValue(imageBuffer: Buffer): Promise<OcrFuelReadingResult> {
    return this.readFuelValueFrom(imageBuffer, undefined);
  }

  /**
   * Igual que `readFuelValue`, pero permite pasar la extensión original del
   * archivo subido (ej. `.png`, `.heic`) para el temporal — el decode en el
   * worker python (`cv2.imdecode`/PIL) no depende de la extensión, pero
   * mantenerla ayuda a inspeccionar el temporal a mano si hace falta
   * debuggear.
   */
  async readFuelValueFrom(
    imageBuffer: Buffer,
    originalFilename?: string,
  ): Promise<OcrFuelReadingResult> {
    // Backpressure: si ya hay `MAX_PENDING_REQUESTS` requests aceptadas sin
    // resolver (encoladas o en vuelo), se degrada esta de inmediato — SIN
    // tocar el filesystem (tmp) ni la cola. Chequeo antes de escribir nada
    // a propósito (ver JSDoc de `MAX_PENDING_REQUESTS`).
    if (this.pendingCount >= MAX_PENDING_REQUESTS) {
      this.logger.warn(
        `Limite de requests OCR en cola/vuelo alcanzado (${MAX_PENDING_REQUESTS}), se degrada a UNREADABLE sin escribir el temporal ni encolar`,
      );
      return DEGRADED_RESULT;
    }

    this.pendingCount++;
    const extension = originalFilename
      ? extname(originalFilename) || DEFAULT_EXTENSION
      : DEFAULT_EXTENSION;
    const tmpPath = join(
      tmpdir(),
      `smi-ocr-fuel-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`,
    );

    try {
      await writeFile(tmpPath, imageBuffer);
      return await this.requestReading(tmpPath);
    } catch (error) {
      // Degradación: no debería pasar (writeFile a tmpdir fallando es un
      // problema de infra, no del pipeline OCR en sí), pero el endpoint
      // nunca debe devolver 500 por esto — el usuario tipea a mano.
      this.logger.error(
        'Fallo preparando el temporal para OCR de litros, se degrada a UNREADABLE',
        error instanceof Error ? error.stack : String(error),
      );
      return DEGRADED_RESULT;
    } finally {
      await rm(tmpPath, { force: true });
      // Decrementa en TODOS los desenlaces (éxito, timeout, error de
      // escritura a stdin, muerte del worker) — `requestReading` nunca
      // rechaza (ver su comentario), así que este `finally` siempre corre.
      this.pendingCount--;
    }
  }

  /** Encola una request detrás de la última pendiente (ver `queueTail`). */
  private requestReading(imagePath: string): Promise<OcrFuelReadingResult> {
    const next = this.queueTail.then(() => this.sendRequest(imagePath));
    // Nunca debe rechazar (sendRequest siempre resuelve), pero por las
    // dudas no dejamos que un reject rompa la cola para las siguientes.
    this.queueTail = next.catch(() => DEGRADED_RESULT);
    return next;
  }

  private sendRequest(imagePath: string): Promise<OcrFuelReadingResult> {
    if (!this.worker || !this.ready) {
      this.logger.warn(
        'El worker de OCR no esta listo (python/modelos ausentes, o reiniciando), se degrada a UNREADABLE',
      );
      return Promise.resolve(DEGRADED_RESULT);
    }

    const id = String(this.nextRequestId++);
    const worker = this.worker;

    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        this.logger.error(
          `Timeout (${REQUEST_TIMEOUT_MS}ms) esperando respuesta del worker de OCR (id=${id}), se reinicia el proceso`,
        );
        resolve(DEGRADED_RESULT);
        this.restartWorker('timeout');
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, timeoutHandle });

      try {
        worker.stdin.write(JSON.stringify({ id, path: imagePath }) + '\n');
      } catch (error) {
        // stdin.write puede lanzar si el proceso ya murió justo en este
        // instante (race entre el check de arriba y el write) — degrada
        // esta request puntual, el 'exit' del worker ya dispara su propio
        // restart y resuelve el resto de pendientes.
        this.pending.delete(id);
        clearTimeout(timeoutHandle);
        this.logger.error(
          'Fallo escribiendo al worker de OCR, se degrada a UNREADABLE',
          error instanceof Error ? error.stack : String(error),
        );
        resolve(DEGRADED_RESULT);
      }
    });
  }

  private startWorker(): void {
    if (this.destroyed) return;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(env.pythonBin, [WORKER_SCRIPT_PATH], {
        env: {
          ...process.env,
          OCR_MODELS_DIR: env.ocrModelsDir,
          OCR_THREADS: String(env.ocrThreads),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // `spawn` con un binario inexistente normalmente falla vía el evento
      // 'error' (async), no lanzando — pero por si acaso el bin resuelve a
      // algo que ni siquiera puede intentarse ejecutar, no dejamos que esto
      // tumbe el boot de Nest (ver onModuleInit): logueamos y quedamos
      // degradados hasta el próximo restart.
      this.logger.error(
        'No se pudo lanzar el worker de OCR, el servicio queda degradado hasta el proximo reintento',
        error instanceof Error ? error.stack : String(error),
      );
      this.restartWorker('spawn-throw');
      return;
    }

    this.worker = child;
    this.ready = false;

    const rl = createInterface({ input: child.stdout });
    this.stdoutInterface = rl;
    rl.on('line', (line) => this.handleWorkerLine(line));

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.logger.debug(`[ocr-worker] ${text}`);
    });

    // Sin este listener, escribir a stdin justo cuando el proceso ya murió
    // (race entre el check de `ready` y el `write`) emite un 'error' (EPIPE)
    // sin manejar en el stream, lo que por default de EventEmitter TUMBA
    // todo el proceso Node — no solo esta request.
    child.stdin.on('error', (error) => {
      this.logger.debug(
        `Error escribiendo al stdin del worker de OCR (probablemente ya murió): ${error.message}`,
      );
    });

    child.on('error', (error) => {
      this.logger.error(
        `Error en el proceso worker de OCR (python ausente? bin=${env.pythonBin})`,
        error.stack,
      );
    });

    child.on('exit', (code, signal) => {
      this.logger.warn(
        `El worker de OCR termino (code=${code ?? 'null'}, signal=${signal ?? 'null'}), se reinicia`,
      );
      this.handleWorkerDeath();
    });
  }

  private handleWorkerLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.logger.warn(
        `Linea no-JSON del worker de OCR, ignorada: ${trimmed.slice(0, 200)}`,
      );
      return;
    }

    if (!this.ready) {
      if (isReadyMessage(parsed)) {
        this.ready = true;
        this.restartAttempts = 0;
        this.logger.log(`Worker de OCR listo (version=${parsed.version})`);
      } else {
        this.logger.warn(
          `Linea inesperada del worker de OCR antes de estar listo, ignorada: ${trimmed.slice(0, 200)}`,
        );
      }
      return;
    }

    if (!isWorkerResponse(parsed)) {
      this.logger.warn(
        `Respuesta con shape invalido del worker de OCR, ignorada: ${trimmed.slice(0, 200)}`,
      );
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) return; // ya resolvió por timeout, o id desconocido — no hay a quién avisarle

    this.pending.delete(parsed.id);
    clearTimeout(pending.timeoutHandle);
    pending.resolve({
      value: parsed.value,
      status: parsed.status,
      confidence: parsed.confidence,
    });
  }

  /** El worker murió por su cuenta (crash, exit espontáneo) — no por un kill nuestro (ver `killWorker`). */
  private handleWorkerDeath(): void {
    this.ready = false;
    this.worker = null;
    this.stdoutInterface?.close();
    this.stdoutInterface = null;
    this.failPendingAsDegraded();

    if (this.destroyed) return;
    this.restartWorker('exit');
  }

  /** Resuelve toda request en vuelo a degradado — usado tanto acá como en `killWorker` para no dejar timers colgados. */
  private failPendingAsDegraded(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.resolve(DEGRADED_RESULT);
    }
    this.pending.clear();
  }

  private restartWorker(reason: string): void {
    if (this.destroyed) return;
    this.killWorker();

    const attempt = this.restartAttempts++;
    const delay =
      RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)];
    this.logger.warn(
      `Reintentando worker de OCR en ${delay}ms (motivo: ${reason}, intento ${attempt + 1})`,
    );

    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.destroyed) this.startWorker();
    }, delay);
  }

  /**
   * Mata el proceso actual (si existe) sin disparar un restart adicional —
   * lo dispara el caller (`restartWorker`) o no (`onModuleDestroy`). Se
   * sacan los listeners de 'exit'/'error' ANTES de matar: si no, el 'exit'
   * real del proceso (asíncrono) dispararía `handleWorkerDeath` también,
   * duplicando el restart cuando quien llamó a `killWorker` ya va a
   * relanzar por su cuenta.
   */
  private killWorker(): void {
    if (this.worker) {
      this.worker.removeAllListeners('exit');
      this.worker.removeAllListeners('error');
      this.worker.kill();
    }
    this.stdoutInterface?.close();
    this.stdoutInterface = null;
    this.worker = null;
    this.ready = false;
    this.failPendingAsDegraded();
  }
}

interface WorkerReadyMessage {
  ready: true;
  version: string;
}

function isReadyMessage(value: unknown): value is WorkerReadyMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.ready === true && typeof candidate.version === 'string';
}

interface WorkerResponse {
  id: string;
  value: string | null;
  status: OcrFuelReadingStatus;
  confidence: number;
}

const OCR_STATUSES: readonly OcrFuelReadingStatus[] = [
  'CONFIRMED',
  'REVIEW',
  'UNREADABLE',
];

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const hasId = typeof candidate.id === 'string';
  const hasValue =
    candidate.value === null || typeof candidate.value === 'string';
  const hasStatus =
    typeof candidate.status === 'string' &&
    (OCR_STATUSES as string[]).includes(candidate.status);
  const hasConfidence = typeof candidate.confidence === 'number';
  return hasId && hasValue && hasStatus && hasConfidence;
}
