import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { trimName } from './create-category.dto';

/**
 * Solo el nombre: la categoría no tiene más ficha que eso. Renombrarla es
 * seguro — los ítems apuntan por `categoryId`, así que corregir "Filttros" no
 * los desvincula.
 */
export class UpdateCategoryDto {
  @IsOptional()
  @Transform(trimName)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;
}
