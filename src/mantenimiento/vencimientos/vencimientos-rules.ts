/**
 * Reglas del Módulo 4 · R21 (alertas de vencimiento documental y mantención de
 * livianos por kilometraje). Funciones puras: las usa la revisión periódica y
 * el calendario.
 */
import { daysBetweenDateOnly } from '../../equipment/document-expiry';

/** Cada cuántos km se hace la mantención de un vehículo liviano. */
export const LIGHT_SERVICE_INTERVAL_KM = 10_000;

/** Con cuántos km de anticipación se avisa (y se crea la orden del taller). */
export const LIGHT_SERVICE_ALERT_KM = 1_000;

/** Tipos de documento que no vencen: nunca generan aviso. */
export const DOCUMENT_TYPES_WITHOUT_EXPIRY = ['MAINTENANCE_MANUAL'] as const;

export interface LightService {
  /** El kilometraje en que toca la próxima mantención (20.000, 30.000…). */
  nextKm: number;
  /** Cuántos km faltan. 0 = toca ahora. */
  remainingKm: number;
  /** Ya está dentro del margen de aviso. */
  due: boolean;
}

/**
 * La próxima mantención por kilometraje: el siguiente múltiplo de 10.000 km.
 * Con el odómetro justo en un múltiplo, toca ahora. Sin lectura, `null`.
 */
export function nextLightService(
  mileage: number | null,
  interval = LIGHT_SERVICE_INTERVAL_KM,
  alertKm = LIGHT_SERVICE_ALERT_KM,
): LightService | null {
  if (mileage == null || mileage < 0) return null;
  const nextKm = Math.max(interval, Math.ceil(mileage / interval) * interval);
  const remainingKm = Math.round((nextKm - mileage) * 10) / 10;
  return { nextKm, remainingKm, due: remainingKm <= alertKm };
}

export type DocumentAlertKind = 'POR_VENCER' | 'VENCIDO';

/**
 * Qué aviso le corresponde hoy a un documento: `VENCIDO` si ya pasó la fecha,
 * `POR_VENCER` si entró en su plazo de anticipación, o `null`.
 */
export function documentAlertKind(
  expiryDate: Date | null,
  alertDaysBefore: number,
  now: Date = new Date(),
): DocumentAlertKind | null {
  if (!expiryDate) return null;
  const dias = daysBetweenDateOnly(now, expiryDate);
  if (dias < 0) return 'VENCIDO';
  if (dias <= alertDaysBefore) return 'POR_VENCER';
  return null;
}

/** Cómo se nombra cada tipo de documento en los avisos y el calendario. */
export const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  TECHNICAL_INSPECTION: 'Revisión técnica',
  INSURANCE: 'Seguro',
  CIRCULATION_PERMIT: 'Permiso de circulación',
  CERTIFICATION: 'Certificación',
  MAINTENANCE_MANUAL: 'Manual de mantención',
  OTHER: 'Documento',
};
