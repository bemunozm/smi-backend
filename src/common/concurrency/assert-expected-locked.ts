import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { assertExpected, type ExpectedValues } from './expected-fields';
import { lockRow, type LockableTable } from './lock-row';

export interface AssertExpectedLockedOptions<
  T extends Record<string, unknown>,
> {
  tx: Prisma.TransactionClient;
  table: LockableTable;
  id: string;
  /** Precondición del cliente. Sin ella no hay nada que comparar. */
  expected: ExpectedValues | undefined;
  /**
   * Lee SOLO los campos que admiten precondición, bajo el bloqueo. Lo que no
   * se devuelve acá (una foto, un archivo) no puede provocar un conflicto.
   */
  read: (tx: Prisma.TransactionClient) => Promise<T | null>;
  /**
   * Lo que el body quiere dejar: solo los campos presentes. Cuando el valor
   * final depende de lo guardado (`dto.campo ?? actual.campo`), se pasa una
   * función de la fila vigente: se evalúa DESPUÉS del bloqueo, así lo que se
   * compara y lo que el caller escribe parten del mismo dato. Puede validar y
   * lanzar: corre antes de la comparación contra `X-Expected`.
   */
  desired:
    | Record<string, unknown>
    | ((
        current: T,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>);
  /**
   * Los campos de la fila que admiten precondición, cuando `read` devuelve
   * más que eso (relaciones, columnas internas). Por defecto, la fila entera.
   */
  comparable?: (current: T) => Record<string, unknown>;
  labels: Record<string, string>;
  notFoundMessage: string;
  /** Error propio del 404 (con `code`), si el dominio lo necesita. */
  notFoundError?: () => Error;
}

/**
 * Bloquea la fila, la relee y valida la precondición `X-Expected` contra el
 * valor vigente. Va dentro del `$transaction` de la escritura: una edición
 * concurrente espera el bloqueo y ve el resultado de la otra, en vez de pisarla.
 *
 * El bloqueo y la relectura ocurren SIEMPRE, haya o no `X-Expected`: lo que el
 * caller calcula a partir de la fila devuelta (el valor nuevo, el diff del
 * historial) es siempre sobre el dato vigente, nunca sobre una lectura previa
 * que otra edición pudo dejar vieja.
 *
 * Devuelve la fila leída para que el caller derive efectos (eventos, cambios
 * de estado) del valor previo bajo el mismo bloqueo.
 */
export async function assertExpectedLocked<T extends Record<string, unknown>>(
  options: AssertExpectedLockedOptions<T>,
): Promise<T> {
  const {
    tx,
    table,
    id,
    expected,
    read,
    desired,
    comparable,
    labels,
    notFoundMessage,
    notFoundError,
  } = options;
  const notFound = (): Error =>
    notFoundError ? notFoundError() : new NotFoundException(notFoundMessage);
  if (!(await lockRow(tx, table, id))) throw notFound();
  const current = await read(tx);
  if (!current) throw notFound();
  const wanted =
    typeof desired === 'function' ? await desired(current) : desired;
  assertExpected(
    comparable ? comparable(current) : current,
    expected,
    wanted,
    labels,
  );
  return current;
}

/**
 * Los campos del DTO que el cliente mandó. Una propiedad `undefined` es
 * «no tocar» (no se compara ni se escribe); `null` sí es un valor.
 */
export function definedFields<T extends object>(
  dto: T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(dto).filter(([, value]) => value !== undefined),
  );
}
