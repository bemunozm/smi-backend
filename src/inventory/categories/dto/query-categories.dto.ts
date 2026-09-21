import { ItemType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { trimName } from './create-category.dto';

export class QueryCategoriesDto {
  /** Búsqueda por nombre, para el selector del formulario de ítems. */
  @IsOptional()
  @Transform(trimName)
  @IsString()
  @MaxLength(60)
  q?: string;

  /**
   * Deja solo las categorías que **tienen al menos un ítem de ese tipo**, y
   * cuenta únicamente esos ítems.
   *
   * Es para el filtro de la pantalla de Inventario, que trabaja sobre una
   * pestaña a la vez: ofrecer «Neumáticos y llantas» mientras se miran los
   * suministros lleva a un listado vacío y a pensar que se perdió el stock.
   *
   * La pantalla de administración de la taxonomía NO lo usa: ahí se ven todas,
   * incluidas las vacías, porque justamente se van a llenar.
   */
  @IsOptional()
  @IsEnum(ItemType)
  type?: ItemType;
}
