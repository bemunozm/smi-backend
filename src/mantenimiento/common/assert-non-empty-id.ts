import { BadRequestException } from '@nestjs/common';

/**
 * Mismo criterio que `users.controller.ts`: los ids de este dominio son
 * cuid (no UUID) — validación simple de string no vacío, no `ParseUUIDPipe`.
 */
export function assertNonEmptyId(id: string, label = 'id'): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException(
      `El parámetro "${label}" no puede estar vacío`,
    );
  }
}
