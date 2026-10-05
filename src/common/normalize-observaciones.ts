/**
 * Normalización de texto libre (M2(b) de la auditoría de seguridad) — se
 * aplica a `CloseShiftCardDto.observaciones` vía `@Transform` ANTES de
 * `@MaxLength`, para que el límite se mida sobre el texto ya normalizado (no
 * sobre un texto con saltos de línea redundantes que un supervisor pegó
 * desde otra app). No valida nada — devuelve el valor tal cual si no es
 * string, para que `@IsString()` sea quien reporte el error de tipo.
 */
export function normalizeObservaciones(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  return value
    .replace(/\r\n/g, '\n') // CRLF -> LF
    .replace(/\n{3,}/g, '\n\n') // 3+ saltos seguidos -> 2
    .trim();
}
