import { ConflictException } from '@nestjs/common';

import { ERROR_CODES } from '../errors/error-codes';

/** Lo que hace falta saber de una tarjeta para decidir un cierre repetido. */
export interface CloseRaceCard {
  closeClientId: string | null;
  valorFinal: number | null;
}

export interface ResolveCloseRaceOptions<T, C extends CloseRaceCard> {
  /** La tarjeta releída FUERA de la transacción abortada; `null` si no existe. */
  existing: C | null;
  /** Id de cierre del cliente (`@unique` en toda la tabla). */
  closeClientId: string;
  /** Respuesta del reintento propio: la tarjeta tal como quedó cerrada. */
  replay: (existing: C) => T | Promise<T>;
  /** Error de «ya estaba cerrada», con el mensaje propio de cada flujo. */
  alreadyClosed: () => Error;
}

/**
 * Desenlace de un cierre que chocó contra otro (índice único de
 * `closeClientId` o `count === 0` del cierre condicional):
 *
 * - mismo `closeClientId` en esta tarjeta: es mi propio reintento, se responde
 *   la tarjeta cerrada;
 * - la tarjeta sigue abierta: el id ya lo usó OTRA tarjeta, así que el
 *   conflicto es el id duplicado y no el estado de ésta (`ID_CONFLICT`);
 * - si no, la tarjeta ya estaba cerrada por otro cierre (`alreadyClosed`).
 *
 * Lo comparten el cierre de Terreno y la salida de Flota, que cierran la misma
 * tabla con el mismo contrato de idempotencia.
 */
export async function resolveCloseRace<T, C extends CloseRaceCard>(
  options: ResolveCloseRaceOptions<T, C>,
): Promise<T> {
  const { existing, closeClientId, replay, alreadyClosed } = options;

  if (existing?.closeClientId === closeClientId) return replay(existing);

  if (existing && existing.valorFinal == null) {
    throw new ConflictException({
      message: 'El id de cierre ya fue usado por otra tarjeta',
      code: ERROR_CODES.ID_CONFLICT,
    });
  }

  throw alreadyClosed();
}
