import { OrigenMovimiento, TipoMovimiento } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Filtros del kardex general. `desde`/`hasta` habilitan la consulta "por
 * período" que pide el documento de requerimientos (§5.6).
 */
export class QueryMovimientosDto {
  @IsOptional()
  @IsString()
  insumoId?: string;

  @IsOptional()
  @IsString()
  equipoId?: string;

  @IsOptional()
  @IsEnum(TipoMovimiento)
  tipo?: TipoMovimiento;

  @IsOptional()
  @IsEnum(OrigenMovimiento)
  origen?: OrigenMovimiento;

  @IsOptional()
  @IsISO8601()
  desde?: string;

  @IsOptional()
  @IsISO8601()
  hasta?: string;

  /** Tope de filas. Por defecto 100 — el kardex crece sin límite. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
