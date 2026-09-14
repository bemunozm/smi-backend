import { MovementDirection, MovementReason } from '@prisma/client';
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
 * Filtros del kardex general. `from`/`to` habilitan la consulta por período.
 */
export class QueryMovementsDto {
  @IsOptional()
  @IsString()
  itemId?: string;

  /** Kardex de UNA bodega — la trazabilidad que exige el modelo multi-sucursal. */
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  equipmentId?: string;

  @IsOptional()
  @IsEnum(MovementDirection)
  direction?: MovementDirection;

  @IsOptional()
  @IsEnum(MovementReason)
  reason?: MovementReason;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  /** Tope de filas. Por defecto 100 — el kardex crece sin límite. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
