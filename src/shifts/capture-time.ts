/**
 * Validación de la hora de captura del dispositivo (RFC Supervisión en
 * Terreno §Diseño: "no se rechaza por desfase razonable: se audita; solo se
 * rechaza lo absurdo"). `fecha`/`fechaSalida` de una tarjeta son SIEMPRE la
 * hora del dispositivo (`capturedAt`), no la del servidor — un supervisor sin
 * señal puede abrir/cerrar una tarjeta con el reloj del teléfono desfasado, y
 * eso es exactamente el caso que el outbox offline necesita soportar. Lo
 * único que se rechaza es un valor que no puede ser correcto bajo ninguna
 * circunstancia razonable (reloj mal configurado, bug del cliente).
 */
import { BadRequestException } from '@nestjs/common';

export const MAX_FUTURE_CAPTURE_SKEW_MS = 24 * 60 * 60 * 1000; // 24 h
export const MAX_PAST_CAPTURE_SKEW_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

/** Rango de la columna Postgres `INTEGER` (`client_clock_skew_ms INT4`) —
 * ver B1 de la auditoría de seguridad: un `X-Client-Time` absurdo (ej. el
 * epoch, `1970-01-01T00:00:00Z`) produce un desfase en ms que desborda INT4
 * y Prisma lo rechaza con un error no controlado (500). El campo es
 * SOLO auditoría, así que nunca debe poder tumbar un write. */
const POSTGRES_INT4_MAX = 2_147_483_647;

/**
 * 400 `INVALID_CAPTURE_TIME` si `capturedAt` está a más de 24 h en el futuro
 * o más de 7 días en el pasado respecto de `now` (la hora del servidor).
 */
export function assertReasonableCapturedAt(
  capturedAt: Date,
  now: Date = new Date(),
): void {
  if (Number.isNaN(capturedAt.getTime())) {
    throw new BadRequestException({
      message: 'La hora de captura no es una fecha válida',
      code: 'INVALID_CAPTURE_TIME',
    });
  }

  const diffMs = capturedAt.getTime() - now.getTime();
  if (
    diffMs > MAX_FUTURE_CAPTURE_SKEW_MS ||
    diffMs < -MAX_PAST_CAPTURE_SKEW_MS
  ) {
    throw new BadRequestException({
      message:
        'La hora del dispositivo está fuera de rango (más de 24 h en el futuro o más de 7 días de antigüedad)',
      code: 'INVALID_CAPTURE_TIME',
    });
  }
}

/**
 * `serverNow − clientNow` a partir del header opcional `X-Client-Time` (ISO,
 * enviado por el dispositivo al abrir una tarjeta) — se AUDITA
 * (`RegistroHorometro.clientClockSkewMs`), nunca se usa para rechazar. Header
 * ausente o valor no parseable → `undefined` (no se guarda skew, no se
 * rechaza): un cliente viejo sin el header sigue funcionando igual que antes.
 */
export function computeClientClockSkewMs(
  clientTimeHeader: string | undefined,
  now: Date = new Date(),
): number | undefined {
  if (!clientTimeHeader) return undefined;

  const clientNow = new Date(clientTimeHeader);
  if (Number.isNaN(clientNow.getTime())) return undefined;

  const skewMs = now.getTime() - clientNow.getTime();
  // B1: un reloj de dispositivo absurdo (ej. el epoch) produce un desfase de
  // varias décadas en milisegundos, que desborda `INTEGER` en Postgres. El
  // campo es auditoría pura — se descarta el dato en vez de fallar el write.
  if (Math.abs(skewMs) > POSTGRES_INT4_MAX) return undefined;

  return skewMs;
}

/**
 * `photoCapturedAt` es EXIF leído por el dispositivo (reloj de la cámara,
 * puede venir mal configurado o en un formato que `IsDateString` deja pasar
 * pero `Date` no puede parsear, ej. `"2026-W01"`) — B2(d)/(e) de la
 * auditoría de seguridad. A diferencia de `capturedAt`/`requestedAt` (que SÍ
 * rechazan con `assertReasonableCapturedAt`), acá un valor no parseable o
 * fuera de la ventana razonable se IGNORA silenciosamente y se usa
 * `fallback` — nunca se rechaza la request: un `close` que quedara
 * encallado para siempre en el outbox offline por un EXIF corrupto sería
 * peor que perder ese dato puntual (que además es no-crítico, solo alimenta
 * `RegistroCombustible.fecha`).
 */
export function resolveCapturedAtWithFallback(
  value: string | undefined,
  fallback: Date,
  now: Date = new Date(),
): Date {
  if (!value) return fallback;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;

  const diffMs = parsed.getTime() - now.getTime();
  if (
    diffMs > MAX_FUTURE_CAPTURE_SKEW_MS ||
    diffMs < -MAX_PAST_CAPTURE_SKEW_MS
  ) {
    return fallback;
  }

  return parsed;
}
