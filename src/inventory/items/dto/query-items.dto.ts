import { ItemType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** `?isActive=true` llega como string en la query — se normaliza a boolean. */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class QueryItemsDto {
  /** Búsqueda libre por SKU, nombre o número de parte. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  q?: string;

  /** Alimenta las pestañas suministros/repuestos de la pantalla (T15). */
  @IsOptional()
  @IsEnum(ItemType)
  type?: ItemType;

  @IsOptional()
  @IsString()
  categoryId?: string;

  /**
   * Sin el filtro se devuelven todos. La pantalla pide `isActive=true`: un ítem
   * dado de baja sigue existiendo para que su kardex se lea, pero no debe
   * aparecer en los selectores.
   */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;
}
