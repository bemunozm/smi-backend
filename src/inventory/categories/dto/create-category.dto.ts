import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * El nombre llega tal cual lo escribe el bodeguero. Se recorta antes de validar
 * porque " Filtros" y "Filtros" son la misma categoría para cualquiera que mire
 * la lista, pero dos filas distintas para el índice único.
 */
export const trimName = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

export class CreateCategoryDto {
  @Transform(trimName)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;
}
