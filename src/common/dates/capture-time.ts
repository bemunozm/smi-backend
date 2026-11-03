/**
 * Hora de captura del dispositivo. Un teléfono sin señal ni NTP puede tener el
 * reloj desfasado, y un registro encolado puede sincronizarse días después:
 * rechazar por eso dejaría el dato atascado en la cola sin forma de
 * corregirlo. Por eso la hora del dispositivo nunca rechaza un registro:
 *
 * - dentro de la ventana razonable se usa tal cual;
 * - fuera de ella (reloj mal puesto, cola vieja) se usa la hora del servidor y
 *   se informa el desfase, para que quede auditado donde haya columna;
 * - solo un valor que no es una fecha (formato inválido) es 400, porque eso sí
 *   es un bug del cliente que reintentar no arregla.
 */
import { BadRequestException } from '@nestjs/common';

import { ERROR_CODES } from '../errors/error-codes';

export const MAX_FUTURE_CAPTURE_SKEW_MS = 24 * 60 * 60 * 1000; // 24 h
export const MAX_PAST_CAPTURE_SKEW_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

/** Rango de la columna Postgres `INTEGER` (`client_clock_skew_ms INT4`): un
 * desfase mayor desborda y Prisma lo rechaza con un 500. El campo es solo
 * auditoría, así que nunca debe poder tumbar un write. */
const POSTGRES_INT4_MAX = 2_147_483_647;

/** El desfase si cabe en `INTEGER`; si no, se descarta el dato. */
function boundedSkewMs(skewMs: number): number | undefined {
  return Math.abs(skewMs) > POSTGRES_INT4_MAX ? undefined : skewMs;
}

function isWithinCaptureWindow(date: Date, now: Date): boolean {
  const diffMs = date.getTime() - now.getTime();
  return (
    diffMs <= MAX_FUTURE_CAPTURE_SKEW_MS && diffMs >= -MAX_PAST_CAPTURE_SKEW_MS
  );
}

export interface ResolvedCaptureTime {
  /** La hora a guardar: la del dispositivo o, si no sirve, la del servidor. */
  at: Date;
  /**
   * `servidor − dispositivo` en ms, solo cuando se descartó la hora del
   * dispositivo por estar fuera de la ventana (y cabe en `INTEGER`).
   */
  discardedSkewMs: number | undefined;
}

/**
 * Resuelve la hora de captura de un registro. Sin valor, o con un valor fuera
 * de la ventana razonable, usa `now`. Un valor que no se puede interpretar
 * como fecha es 400 `INVALID_CAPTURE_TIME`.
 */
export function resolveCapturedAt(
  capturedAt: string | undefined,
  now: Date = new Date(),
): ResolvedCaptureTime {
  if (!capturedAt) return { at: now, discardedSkewMs: undefined };

  const captured = new Date(capturedAt);
  if (Number.isNaN(captured.getTime())) {
    throw new BadRequestException({
      message: 'La hora de captura no es una fecha válida',
      code: ERROR_CODES.INVALID_CAPTURE_TIME,
    });
  }
  if (isWithinCaptureWindow(captured, now)) {
    return { at: captured, discardedSkewMs: undefined };
  }
  return {
    at: now,
    discardedSkewMs: boundedSkewMs(now.getTime() - captured.getTime()),
  };
}

/** Margen para «futura»: el reloj del navegador y el del servidor no calzan
 * al segundo, y una fecha de «ahora» no debe rebotar por eso. */
export const MAX_RECORD_DATE_FUTURE_MS = 5 * 60 * 1000; // 5 min

/**
 * Fecha de un registro cargado desde el panel (`fecha`): un hallazgo o un
 * trabajo extra que el supervisor olvidó y se carga después. A diferencia de
 * `capturedAt` no es la hora del dispositivo sino una elección explícita, así
 * que no tiene ventana hacia atrás; solo no puede ser futura (400
 * `INVALID_RECORD_DATE`). Sin `fecha`, manda `capturedAt` como siempre.
 */
export function resolveRecordDate(
  fecha: string | undefined,
  capturedAt: string | undefined,
  now: Date = new Date(),
): Date {
  if (!fecha) return resolveCapturedAt(capturedAt, now).at;
  const elegida = new Date(fecha);
  if (Number.isNaN(elegida.getTime())) {
    throw new BadRequestException({
      message: 'La fecha no es válida',
      code: ERROR_CODES.INVALID_RECORD_DATE,
    });
  }
  if (elegida.getTime() - now.getTime() > MAX_RECORD_DATE_FUTURE_MS) {
    throw new BadRequestException({
      message: 'La fecha no puede ser futura',
      code: ERROR_CODES.INVALID_RECORD_DATE,
    });
  }
  return elegida;
}

/**
 * `serverNow − clientNow` a partir del header opcional `X-Client-Time` (ISO,
 * enviado por el dispositivo al abrir una tarjeta). Se audita
 * (`RegistroHorometro.clientClockSkewMs`), nunca se usa para rechazar. Header
 * ausente o valor no parseable devuelve `undefined`.
 */
export function computeClientClockSkewMs(
  clientTimeHeader: string | undefined,
  now: Date = new Date(),
): number | undefined {
  if (!clientTimeHeader) return undefined;

  const clientNow = new Date(clientTimeHeader);
  if (Number.isNaN(clientNow.getTime())) return undefined;

  return boundedSkewMs(now.getTime() - clientNow.getTime());
}

/**
 * `photoCapturedAt` es EXIF leído por el dispositivo (reloj de la cámara,
 * puede venir mal configurado o en un formato que `IsDateString` deja pasar
 * pero `Date` no puede parsear, ej. `"2026-W01"`). Un valor no parseable o
 * fuera de la ventana razonable se IGNORA y se usa `fallback`: perder ese dato
 * puntual (que solo alimenta `RegistroCombustible.fecha`) es mejor que dejar
 * un cierre encallado en el outbox por un EXIF corrupto.
 */
export function resolveCapturedAtWithFallback(
  value: string | undefined,
  fallback: Date,
  now: Date = new Date(),
): Date {
  if (!value) return fallback;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;

  return isWithinCaptureWindow(parsed, now) ? parsed : fallback;
}
