/**
 * Utilidades puras para el RUT chileno (catálogo de Operadores, RFC
 * Supervisión en Terreno). Sin dependencias de Nest/class-validator/Prisma a
 * propósito — se testean a secas y las reusa tanto el DTO (`IsChileanRut`,
 * ver `dto/is-chilean-rut.validator.ts`) como `OperatorsService` para
 * persistir siempre la forma canónica.
 */

const NON_RUT_CHARS_REGEX = /[.\s-]/g;
const RUT_SHAPE_REGEX = /^\d{7,8}[0-9K]$/;

/** Quita puntos/espacios/guion y pasa la "k" a mayúscula. No valida forma. */
function clean(raw: string): string {
  return raw.replace(NON_RUT_CHARS_REGEX, '').toUpperCase();
}

/** Dígito verificador módulo 11, algoritmo estándar del RUT chileno. */
function computeCheckDigit(body: string): string {
  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const remainder = 11 - (sum % 11);
  if (remainder === 11) return '0';
  if (remainder === 10) return 'K';
  return String(remainder);
}

/**
 * `true` si `raw` es un RUT chileno con dígito verificador correcto.
 * Tolera puntos/guion/espacios y mayúsculas/minúsculas en la "k" — NO
 * exige el formato canónico de entrada (eso lo resuelve `normalizeRut`).
 */
export function isValidRut(raw: string): boolean {
  const value = clean(raw);
  if (!RUT_SHAPE_REGEX.test(value)) return false;

  const body = value.slice(0, -1);
  const checkDigit = value.slice(-1);
  return computeCheckDigit(body) === checkDigit;
}

/**
 * Normaliza un RUT válido al formato canónico `12345678-K` que persiste
 * `Operator.rut`. Llamar siempre DESPUÉS de confirmar `isValidRut(raw)` —
 * lanza si no lo es, para no guardar silenciosamente un RUT mal formado.
 */
export function normalizeRut(raw: string): string {
  if (!isValidRut(raw)) {
    throw new Error(`RUT inválido: "${raw}"`);
  }
  const value = clean(raw);
  // B4(b) de la auditoría de seguridad: un cero a la izquierda en el cuerpo
  // ("01234567-K") no cambia el dígito verificador (multiplica por 0 en el
  // algoritmo módulo 11) — sigue siendo el MISMO RUT que "1234567-K", pero
  // sin colapsar el cero, `clean()` a secas los deja como dos strings
  // DISTINTOS y el `@unique` de `Operator.rut` no los detecta como
  // duplicados. `Number(...)` colapsa cualquier cantidad de ceros a la
  // izquierda; el cuerpo cabe sobrado en un entero seguro (máx. 8 dígitos).
  const body = String(Number(value.slice(0, -1)));
  const checkDigit = value.slice(-1);
  return `${body}-${checkDigit}`;
}
