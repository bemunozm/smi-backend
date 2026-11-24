import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trimOrNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export class CompatibilityEntryDto {
  @IsString()
  @MinLength(1)
  equipmentId!: string;

  /** Salvedad opcional ("solo desde serie 4500"). Vacío se guarda como nulo. */
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(200)
  note?: string | null;
}

/**
 * Body de `PUT /api/inventory/items/:id/compatibilities`: el set COMPLETO de
 * equipos del ítem. Lo que no viene se quita; `[]` deja el ítem sin equipos.
 */
export class SetCompatibilitiesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CompatibilityEntryDto)
  entries!: CompatibilityEntryDto[];
}
