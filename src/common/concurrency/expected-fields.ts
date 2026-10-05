import { BadRequestException, ConflictException } from '@nestjs/common';

import { ERROR_CODES } from '../errors/error-codes';

/** Valores base que el cliente vio al empezar a editar: `{ campo: valorBase }`. */
export type ExpectedValues = Record<string, unknown>;

export const EXPECTED_HEADER = 'x-expected';

/**
 * Tope del header ya codificado. Node corta los headers sobre 16 KB con un
 * 431 que el cliente offline trata como error de negocio; 8 KB deja margen y
 * sobra para los campos editables de cualquier registro.
 */
export const EXPECTED_HEADER_MAX_LENGTH = 8 * 1024;

const isPrimitive = (value: unknown): boolean =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

/**
 * Lee el header opcional `X-Expected`. Sin header (o vacío) no hay
 * precondición y la última escritura gana, como antes de que existiera.
 */
export function parseExpectedHeader(
  raw: string | undefined,
): ExpectedValues | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (raw.length > EXPECTED_HEADER_MAX_LENGTH) {
    throw new BadRequestException(
      `El header X-Expected supera el máximo de ${EXPECTED_HEADER_MAX_LENGTH} caracteres`,
    );
  }

  // Los navegadores rechazan valores de header fuera de Latin-1 y la base
  // puede llevar texto libre («—», comillas tipográficas, emojis): el cliente
  // manda `encodeURIComponent(JSON.stringify(expected))`.
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    throw new BadRequestException(
      'El header X-Expected no es válido: se espera encodeURIComponent(JSON)',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestException(
      'El header X-Expected debe ser un objeto { campo: valorBase }',
    );
  }

  // Solo valores comparables: un objeto anidado no tiene forma de coincidir
  // con una columna y obligaría a recorrerlo (o serializarlo) sin tope.
  // Los arreglos de primitivos son las listas (las actividades de un trabajo).
  const entries = Object.entries(parsed);
  const invalido = entries.find(
    ([, value]) =>
      !(
        isPrimitive(value) ||
        (Array.isArray(value) && value.every((item) => isPrimitive(item)))
      ),
  );
  if (invalido) {
    throw new BadRequestException(
      `El valor de «${invalido[0]}» en X-Expected debe ser texto, número, booleano, null o una lista de ellos`,
    );
  }
  return Object.fromEntries(entries);
}

/**
 * Deja comparables dos valores que significan lo mismo: `null` y `undefined`
 * (y el texto vacío) son «sin valor», el texto se compara sin espacios en los
 * bordes y los números por valor.
 */
export function normalizeComparable(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (value instanceof Date) return value.toISOString();
  // Un arreglo (las actividades de un trabajo) no se compara con `!==`.
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * Precondición por campo (control de concurrencia optimista sin versión): un
 * campo pasa si el registro sigue como el cliente lo vio (`current ==
 * expected`) o si ya tiene el valor que el cliente quiere dejar (`current ==
 * desired`) — lo segundo vuelve idempotente el reintento de una edición que
 * llegó pero cuya respuesta se perdió. Cualquier otro caso es que alguien más
 * cambió el dato en el medio: 409 `STALE_UPDATE`.
 *
 * Los campos de `expected` que `current` no conoce se ignoran: un cliente
 * más nuevo que el servidor no debe poder provocar conflictos falsos.
 */
export function assertExpected(
  current: Record<string, unknown>,
  expected: ExpectedValues | undefined,
  desired: Record<string, unknown>,
  labels: Record<string, string> = {},
): void {
  if (!expected) return;

  const stale = Object.keys(expected).filter((field) => {
    // `Object.hasOwn`: `in` también ve lo heredado (`constructor`, `toString`).
    if (!Object.hasOwn(current, field)) return false;
    const actual = normalizeComparable(current[field]);
    // Un campo que el body no toca no cambia: se compara contra lo vigente,
    // así no genera ni un falso pase ni un falso conflicto.
    const deseado = Object.hasOwn(desired, field)
      ? desired[field]
      : current[field];
    return (
      actual !== normalizeComparable(expected[field]) &&
      actual !== normalizeComparable(deseado)
    );
  });
  if (stale.length === 0) return;

  // Dos campos pueden compartir etiqueta (el id y el nombre de un operador):
  // se nombra una sola vez.
  const nombres = [
    ...new Set(stale.map((field) => labels[field] ?? field)),
  ].join(', ');
  throw new ConflictException({
    message: `El registro cambió mientras lo editabas (${nombres}). Revisa los datos actuales antes de guardar.`,
    code: ERROR_CODES.STALE_UPDATE,
  });
}
