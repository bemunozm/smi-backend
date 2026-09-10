import { TipoInsumo } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** `?bajoStock=true` llega como string en la query — se normaliza a boolean. */
const aBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

export class QueryInsumosDto {
  /** Búsqueda libre por código o nombre. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(80)
  q?: string;

  /** Separar suministros de repuestos. */
  @IsOptional()
  @IsEnum(TipoInsumo)
  tipo?: TipoInsumo;

  /** Solo los insumos en o por debajo de su stock mínimo GLOBAL. */
  @IsOptional()
  @Transform(aBoolean)
  @IsBoolean()
  bajoStock?: boolean;
}
