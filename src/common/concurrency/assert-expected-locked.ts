import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { assertExpected, type ExpectedFields } from './expected-fields';
import { lockRow, type LockableTable } from './lock-row';

export interface AssertExpectedLockedOptions<
  T extends Record<string, unknown>,
> {
  tx: Prisma.TransactionClient;
  table: LockableTable;
  id: string;
  /** Precondición del cliente. Sin ella no hay nada que comparar. */
  expected: ExpectedFields | undefined;
  /**
   * Lee SOLO los campos que admiten precondición, bajo el bloqueo. Lo que no
   * se devuelve acá (una foto, un archivo) no puede provocar un conflicto.
   */
  read: (tx: Prisma.TransactionClient) => Promise<T | null>;
  /** Lo que el body quiere dejar: solo los campos presentes. */
  desired: Record<string, unknown>;
  labels: Record<string, string>;
  notFoundMessage: string;
}

/**
 * Bloquea la fila, la relee y valida la precondición `X-Expected` contra el
 * valor vigente. Va dentro del `$transaction` de la escritura: una edición
 * concurrente espera el bloqueo y ve el resultado de la otra, en vez de pisarla.
 *
 * Devuelve la fila leída para que el caller derive efectos (eventos, cambios
 * de estado) del valor previo bajo el mismo bloqueo.
 */
export async function assertExpectedLocked<T extends Record<string, unknown>>(
  options: AssertExpectedLockedOptions<T>,
): Promise<T> {
  const { tx, table, id, expected, read, desired, labels, notFoundMessage } =
    options;
  if (!(await lockRow(tx, table, id))) {
    throw new NotFoundException(notFoundMessage);
  }
  const current = await read(tx);
  if (!current) throw new NotFoundException(notFoundMessage);
  assertExpected(current, expected, desired, labels);
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
