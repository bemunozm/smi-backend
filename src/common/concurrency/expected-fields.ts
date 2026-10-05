import { BadRequestException, ConflictException } from '@nestjs/common';

import { ERROR_CODES } from '../errors/error-codes';

/** Valores base que el cliente vio al empezar a editar: `{ campo: valorBase }`. */
export type ExpectedFields = Record<string, unknown>;

export const EXPECTED_HEADER = 'x-expected';

/**
 * Lee el header opcional `X-Expected`. Sin header (o vacío) no hay
 * precondición y la última escritura gana, como antes de que existiera.
 */
export function parseExpectedHeader(
  raw: string | undefined,
): ExpectedFields | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

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
  return parsed as ExpectedFields;
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
  expected: ExpectedFields | undefined,
  desired: Record<string, unknown>,
  labels: Record<string, string> = {},
): void {
  if (!expected) return;

  const stale = Object.keys(expected).filter((field) => {
    if (!(field in current)) return false;
    const actual = normalizeComparable(current[field]);
    // Un campo que el body no toca no cambia: se compara contra lo vigente,
    // así no genera ni un falso pase ni un falso conflicto.
    const deseado = field in desired ? desired[field] : current[field];
    return (
      actual !== normalizeComparable(expected[field]) &&
      actual !== normalizeComparable(deseado)
    );
  });
  if (stale.length === 0) return;

  const nombres = stale.map((field) => labels[field] ?? field).join(', ');
  throw new ConflictException({
    message: `El registro cambió mientras lo editabas (${nombres}). Revisa los datos actuales antes de guardar.`,
    code: ERROR_CODES.STALE_UPDATE,
  });
}
