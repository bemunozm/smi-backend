import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODES } from '../errors/error-codes';

/** Una fila ya existente con el id del cliente, lista para devolverse. */
export interface ExistingRecord<T> {
  /** `user.id` que la creó; `null` en filas anteriores al id de cliente. */
  ownerId: string | null;
  /**
   * Misma forma que devuelve un create recién hecho (URLs firmadas frescas).
   * Puede ser una función: solo se evalúa si la fila es del usuario, así un id
   * ajeno no paga las consultas ni las firmas de una respuesta que no se
   * entrega.
   */
  result: T | (() => Promise<T>);
}

export interface CreateOrReturnOptions<T> {
  /** UUID v4 del cliente (= PK de la fila). Sin él, es un create normal. */
  id: string | undefined;
  /** Usuario de la sesión: solo el dueño de la fila puede reintentarla. */
  userId: string;
  findExisting: (id: string) => Promise<ExistingRecord<T> | null>;
  /** Crea la fila. Es responsable de soltar lo que haya reclamado si falla. */
  create: () => Promise<T>;
  /** Mensaje del 409 `ID_CONFLICT` (varía según la entidad). */
  conflictMessage: string;
}

/**
 * Create idempotente por id del cliente, para la cola offline que reintenta
 * hasta tener respuesta.
 *
 * Con `id`, la búsqueda va ANTES de cualquier regla de negocio o claim de
 * archivos: un reintento propio devuelve la fila ya creada aunque el mundo
 * haya cambiado desde entonces, sin repetir efectos (claim, eventos,
 * movimientos de stock). Si el id lo ocupa otro usuario, o una fila sin
 * dueño, es 409 `ID_CONFLICT`.
 *
 * Si dos requests con el mismo id corren a la vez, el perdedor choca contra
 * la PK: se relee FUERA de la transacción (la de Postgres ya quedó abortada)
 * y se aplica el mismo criterio. Un choque contra cualquier otra columna única
 * no es una carrera y sigue su camino de error normal.
 */
export async function createOrReturn<T>(
  options: CreateOrReturnOptions<T>,
): Promise<T> {
  const { id, userId, findExisting, create, conflictMessage } = options;
  if (!id) return create();

  const resolve = async (existing: ExistingRecord<T>): Promise<T> => {
    if (existing.ownerId === userId) {
      return typeof existing.result === 'function'
        ? (existing.result as () => Promise<T>)()
        : existing.result;
    }
    throw new ConflictException({
      message: conflictMessage,
      code: ERROR_CODES.ID_CONFLICT,
    });
  };

  const existing = await findExisting(id);
  if (existing) return resolve(existing);

  try {
    return await create();
  } catch (error: unknown) {
    if (isPrimaryKeyViolation(error)) {
      const winner = await findExisting(id);
      if (winner) return resolve(winner);
    }
    throw error;
  }
}

/**
 * P2002 sobre la PK `id`. Prisma + Postgres informa `meta.target` como arreglo
 * de columnas (`['id']`); algunos drivers entregan el nombre del constraint
 * (`<tabla>_pkey`), así que se aceptan las dos formas.
 */
export function isPrimaryKeyViolation(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }
  const target: unknown = error.meta?.target;
  if (Array.isArray(target)) return target.length === 1 && target[0] === 'id';
  return typeof target === 'string' && target.endsWith('_pkey');
}
