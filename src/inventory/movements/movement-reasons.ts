import { MovementReason } from '@prisma/client';

/**
 * Motivos que solo nacen de su propio endpoint: un traspaso son dos asientos
 * en una transacción y un conteo físico se calcula contra el saldo vigente. Un
 * movimiento manual con uno de estos motivos se haría pasar por uno de ellos
 * en el kardex y en el replay de su endpoint.
 */
export const RESERVED_MOVEMENT_REASONS: readonly MovementReason[] = [
  MovementReason.TRANSFER,
  MovementReason.PHYSICAL_ADJUSTMENT,
];

/** Motivos que admite `POST /inventory/movements`. */
export const MANUAL_MOVEMENT_REASONS: readonly MovementReason[] = Object.values(
  MovementReason,
).filter((reason) => !RESERVED_MOVEMENT_REASONS.includes(reason));

export function isManualMovementReason(reason: MovementReason): boolean {
  return MANUAL_MOVEMENT_REASONS.includes(reason);
}
