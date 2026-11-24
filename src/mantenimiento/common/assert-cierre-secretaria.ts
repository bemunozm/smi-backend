import { ForbiddenException } from '@nestjs/common';

import { ROLES, sessionHasRole } from '../../auth/roles';

/**
 * SECRETARIA cierra la operación que el taller olvidó, solo con «qué se
 * hizo»: sin insumos ni bodega, porque el stock lo mueve el taller. Vale para
 * el alta suelta de la intervención y para «Finalizar» (que la incluye).
 */
export function assertCierreSecretariaSinInsumos(
  role: Parameters<typeof sessionHasRole>[0],
  dto: { insumos?: unknown[]; branchId?: string },
): void {
  if (
    sessionHasRole(role, ROLES.SECRETARIA) &&
    ((dto.insumos?.length ?? 0) > 0 || dto.branchId !== undefined)
  ) {
    throw new ForbiddenException(
      'Secretaría registra el cierre sin insumos: el stock lo descuenta el taller.',
    );
  }
}
