import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * El nombre llega tal cual lo escribe el bodeguero. Se recorta antes de validar
 * porque " Filtros" y "Filtros" son la misma categoría para cualquiera que mire
 * la lista, pero dos filas distintas para el índice único.
 */
export const trimName = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

export class CreateCategoryDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @Transform(trimName)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;
}
