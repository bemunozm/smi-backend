/**
 * Vigencia de documentos de un equipo (`EquipmentDocument`), derivada on-read
 * a partir de `expiryDate` — nunca se persiste. Extraído de
 * `EquipmentService` (donde nació para R1/R2 como columnas planas) para que
 * `EquipmentDocumentService` lo reutilice sin duplicar la lógica: ambos
 * necesitan el mismo cálculo de `status`/`daysToExpiry`.
 */

/**
 * Umbral (en días) para pasar de `VIGENTE` a `POR_VENCER`. Centralizado
 * acá — nunca hardcodear el 30 inline — para que cualquier otro consumidor
 * futuro (ej. un cron de notificaciones) lea el mismo número.
 */
export const DOCUMENT_EXPIRY_WARNING_DAYS = 30;

export type DocumentStatus = 'VIGENTE' | 'POR_VENCER' | 'VENCIDO' | 'SIN_DATO';

/** Estado de vigencia de un documento individual. */
export interface DocumentExpiryInfo {
  /** Fecha de vencimiento en ISO 8601, o `null` si no hay dato cargado. */
  expiry: string | null;
  status: DocumentStatus;
  /** Días de calendario hasta el vencimiento (negativo si ya venció), o `null` sin dato. */
  daysToExpiry: number | null;
}

/**
 * Días de calendario entre `now` y `expiry`, a granularidad de FECHA
 * (ignorando la hora) para evitar el off-by-one de restar dos timestamps
 * completos — sin esto, dos fechas del mismo día calendario pero con horas
 * distintas podrían dar un `daysToExpiry` fraccionario o corrido en ±1.
 * Ambas fechas se normalizan a medianoche UTC antes de restar.
 */
export function daysBetweenDateOnly(now: Date, expiry: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const nowUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const expiryUtc = Date.UTC(
    expiry.getUTCFullYear(),
    expiry.getUTCMonth(),
    expiry.getUTCDate(),
  );
  return Math.round((expiryUtc - nowUtc) / MS_PER_DAY);
}

/**
 * Deriva `status`/`daysToExpiry` de un documento on-read — no se persiste, se
 * recalcula en cada lectura contra el reloj actual. `now` es un parámetro
 * explícito (default `new Date()`) en vez de leer `Date.now()` adentro, para
 * que los tests puedan fijarlo sin mockear el reloj global.
 */
export function buildDocumentExpiryInfo(
  expiry: Date | null,
  now: Date = new Date(),
): DocumentExpiryInfo {
  if (!expiry) {
    return { expiry: null, status: 'SIN_DATO', daysToExpiry: null };
  }
  const daysToExpiry = daysBetweenDateOnly(now, expiry);
  const status: DocumentStatus =
    daysToExpiry < 0
      ? 'VENCIDO'
      : daysToExpiry <= DOCUMENT_EXPIRY_WARNING_DAYS
        ? 'POR_VENCER'
        : 'VIGENTE';
  return { expiry: expiry.toISOString(), status, daysToExpiry };
}
