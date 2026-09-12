import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { trimName } from './create-category.dto';

export class QueryCategoriesDto {
  /** Búsqueda por nombre, para el selector del formulario de ítems. */
  @IsOptional()
  @Transform(trimName)
  @IsString()
  @MaxLength(60)
  q?: string;
}
