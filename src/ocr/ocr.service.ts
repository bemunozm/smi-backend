/**
 * OCR server-side de la lectura de litros del display 7-segmentos de un
 * surtidor, a partir de una foto. Cliente HTTP del worker Python
 * (`ocr-python/worker.py`), que corre como un servicio aparte con un ensemble
 * local de dos modelos ONNX (Florence-2-base fine-tuneado + CRNN-CTC) — ver
 * ese archivo y `ocr-python/README.md` para el pipeline y el despliegue.
 *
 * Precisión validada sobre el test congelado (19 fotos): 15/19 exactas,
 * 0 erróneas (4 a confirmación manual) — ver `ocr-python/README.md`
 * sección "Paridad". El front NO recibe confianza por dígito: recibe un
 * `status` de acuerdo entre los dos modelos (`CONFIRMED`/`REVIEW`/
 * `UNREADABLE`) y decide autollenar o pedir revisión en base a eso.
 *
 * Por qué un servicio aparte y no un proceso hijo: el worker carga ~300MB de
 * modelos y su ciclo de vida (verificación sha256, reinicio ante una
 * inferencia colgada) lo gobierna Docker (`restart: unless-stopped` + el
 * vigilante interno del worker), no este proceso: acá solo se degrada la
 * lectura que no obtuvo respuesta.
 *
 * Cola serial: el worker procesa una inferencia a la vez, así que cada
 * lectura espera a la anterior (`queueTail`) en vez de apilar requests
 * concurrentes dentro del worker, donde competirían por los mismos hilos.
 *
 * Backpressure: una ráfaga de uploads concurrentes se encolaría sin límite si
 * no fuera por `MAX_PENDING_REQUESTS` — pasado ese cupo de requests aceptadas
 * (encoladas + en vuelo) sin resolver, las nuevas se degradan de inmediato
 * sin encolar (ver `readFuelValue`).
 *
 * Degradación: ante cualquier fallo (conexión rechazada, worker aún
 * cargando los modelos -> 503, timeout, cuerpo inválido, error de red) la
 * lectura resuelve a `{ value: null, status: 'UNREADABLE', confidence: 0 }`
 * y el usuario tipea a mano. Nunca devuelve 500 ni bloquea el boot de Nest.
 *
 * Notas de deploy: el worker se ubica por `OCR_WORKER_URL` (ver
 * `src/common/config/env.ts`); modelos, hilos y puerto se configuran en el
 * worker, no acá. Ver "Stack y despliegue con Docker" en el README.
 */
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

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

/**
 * Tibio (modelos ya cargados) el ensemble responde en ~0.5-0.9s en x86 y en
 * ~1.4-2s en el VPS ARM64 (ver benchmark en `ocr-python/README.md`). El
 * plazo cuenta desde que la request entra a la cola serial, así que tiene que
 * cubrir las lecturas que esperan delante (hasta `MAX_PENDING_REQUESTS`): 15s
 * alcanza para una ráfaga de varias fotos en ARM sin dejar una request colgada
 * indefinidamente. Queda por debajo del vigilante del worker
 * (`OCR_READ_WATCHDOG_SECONDS`, 30s), que es quien lo reinicia; esta request
 * solo se degrada.
 */
const REQUEST_TIMEOUT_MS = 15_000;
/** `/health` solo se consulta al arrancar para loguear el estado: no merece esperar tanto. */
const STARTUP_HEALTH_TIMEOUT_MS = 3_000;
/**
 * Tope de requests ACEPTADAS (encoladas detrás de `queueTail` + la que está
 * en vuelo con el worker) que todavía no resolvieron. El worker procesa una
 * request a la vez (cola serial), así que sin este tope una ráfaga de
 * uploads concurrentes (varios choferes subiendo fotos a la vez) encolaría
 * sin límite — cada request esperando cada vez más, hasta el timeout de
 * `REQUEST_TIMEOUT_MS` cada una. Mejor degradar de inmediato las que exceden
 * el cupo: el usuario tipea a mano en vez de esperar 15s para lo mismo.
 */
const MAX_PENDING_REQUESTS = 6;

@Injectable()
export class OcrService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OcrService.name);

  private destroyed = false;
  /** Requests HTTP en vuelo hacia el worker — `onModuleDestroy` las aborta. */
  private readonly inFlight = new Set<AbortController>();
  private queueTail: Promise<OcrFuelReadingResult> =
    Promise.resolve(DEGRADED_RESULT);
  /** Requests aceptadas sin resolver todavía (encoladas o en vuelo) — ver `MAX_PENDING_REQUESTS`. */
  private pendingCount = 0;

  onModuleInit(): void {
    // Solo informativo: nunca se espera ni puede rechazar (ver `logWorkerStatus`).
    void this.logWorkerStatus();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
  }

  async readFuelValue(imageBuffer: Buffer): Promise<OcrFuelReadingResult> {
    // Backpressure: si ya hay `MAX_PENDING_REQUESTS` requests aceptadas sin
    // resolver (encoladas o en vuelo), se degrada esta de inmediato, sin
    // encolar (ver JSDoc de `MAX_PENDING_REQUESTS`).
    if (this.pendingCount >= MAX_PENDING_REQUESTS) {
      this.logger.warn(
        `Limite de requests OCR en cola/vuelo alcanzado (${MAX_PENDING_REQUESTS}), se degrada a UNREADABLE sin encolar`,
      );
      return DEGRADED_RESULT;
    }

    this.pendingCount++;
    try {
      return await this.enqueue(imageBuffer);
    } finally {
      // `sendRequest` nunca rechaza, así que este `finally` siempre corre y
      // el contador baja en TODOS los desenlaces.
      this.pendingCount--;
    }
  }

  /** Encola una request detrás de la última pendiente (ver `queueTail`). */
  private enqueue(imageBuffer: Buffer): Promise<OcrFuelReadingResult> {
    const next = this.queueTail.then(() => this.sendRequest(imageBuffer));
    // `sendRequest` siempre resuelve, pero un reject no debe romper la cola
    // para las requests siguientes.
    this.queueTail = next.catch(() => DEGRADED_RESULT);
    return next;
  }

  private async sendRequest(
    imageBuffer: Buffer,
  ): Promise<OcrFuelReadingResult> {
    if (this.destroyed) return DEGRADED_RESULT;

    const controller = new AbortController();
    this.inFlight.add(controller);
    // El timeout cubre también la lectura del cuerpo de la respuesta, no
    // solo el envío: `signal` sigue vigente hasta `response.json()`.
    const timeoutHandle = setTimeout(
      () => controller.abort(new Error('timeout')),
      REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${env.ocrWorkerUrl}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: asRequestBody(imageBuffer),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 503 = el worker sigue cargando/verificando los modelos (o no los
        // encontró); 4xx/5xx = request inválida o fallo inesperado.
        this.logger.warn(
          `El worker de OCR respondio ${response.status}, se degrada a UNREADABLE`,
        );
        return DEGRADED_RESULT;
      }

      const parsed: unknown = await response.json();
      if (!isWorkerResponse(parsed)) {
        this.logger.warn(
          `Respuesta con shape invalido del worker de OCR, se degrada a UNREADABLE: ${JSON.stringify(parsed).slice(0, 200)}`,
        );
        return DEGRADED_RESULT;
      }

      return {
        value: parsed.value,
        status: parsed.status,
        confidence: parsed.confidence,
      };
    } catch (error) {
      this.logFetchFailure(controller.signal, error);
      return DEGRADED_RESULT;
    } finally {
      clearTimeout(timeoutHandle);
      this.inFlight.delete(controller);
    }
  }

  private logFetchFailure(signal: AbortSignal, error: unknown): void {
    if (this.destroyed) return;
    if (signal.aborted) {
      this.logger.error(
        `Timeout (${REQUEST_TIMEOUT_MS}ms) esperando respuesta del worker de OCR (${env.ocrWorkerUrl}), se degrada a UNREADABLE`,
      );
      return;
    }
    // Conexión rechazada, DNS, reset, JSON truncado... en todos los casos el
    // worker no está disponible para esta request.
    this.logger.error(
      `No se pudo consultar el worker de OCR (${env.ocrWorkerUrl}), se degrada a UNREADABLE`,
      error instanceof Error ? error.stack : String(error),
    );
  }

  /** Loguea el estado del worker al boot; el backend arranca igual si no responde. */
  private async logWorkerStatus(): Promise<void> {
    const controller = new AbortController();
    this.inFlight.add(controller);
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      STARTUP_HEALTH_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${env.ocrWorkerUrl}/health`, {
        signal: controller.signal,
      });
      const body: unknown = await response.json();
      if (response.ok && isReadyMessage(body)) {
        this.logger.log(
          `Worker de OCR listo (${env.ocrWorkerUrl}, version=${body.version})`,
        );
      } else {
        this.logger.warn(
          `Worker de OCR todavia no esta listo (${env.ocrWorkerUrl}, status=${response.status}); las lecturas degradan a UNREADABLE hasta que lo este`,
        );
      }
    } catch {
      if (this.destroyed) return;
      this.logger.warn(
        `Worker de OCR inalcanzable al arrancar (${env.ocrWorkerUrl}); las lecturas degradan a UNREADABLE hasta que responda`,
      );
    } finally {
      clearTimeout(timeoutHandle);
      this.inFlight.delete(controller);
    }
  }
}

/**
 * Vista de los mismos bytes (sin copiar hasta 8MB) con el tipo que exige
 * `BodyInit`. El cast a `ArrayBuffer` es seguro: `Buffer` de multer/Node
 * nunca está respaldado por un `SharedArrayBuffer`, que es lo único que
 * `ArrayBufferLike` agrega y `BodyInit` rechaza.
 */
function asRequestBody(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    buffer.buffer as ArrayBuffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
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
  const hasValue =
    candidate.value === null || typeof candidate.value === 'string';
  const hasStatus =
    typeof candidate.status === 'string' &&
    (OCR_STATUSES as string[]).includes(candidate.status);
  const hasConfidence = typeof candidate.confidence === 'number';
  return hasValue && hasStatus && hasConfidence;
}
