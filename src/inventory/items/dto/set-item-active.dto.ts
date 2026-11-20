import { IsBoolean } from 'class-validator';

/**
 * Body de `PATCH /api/inventory/items/:id/active` — dar de baja o reactivar un
 * ítem. Va aparte de `UpdateItemDto` porque la baja es solo del ADMIN y el
 * resto de la ficha también la edita la SECRETARIA.
 */
export class SetItemActiveDto {
  @IsBoolean()
  isActive!: boolean;
}
