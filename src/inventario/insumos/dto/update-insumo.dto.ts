import { UnidadInsumo } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Edición de la ficha del insumo. **`stock` no está acá a propósito**: el saldo
 * solo se mueve con movimientos de inventario (entrada, salida o ajuste por
 * conteo). Permitir editarlo a mano rompería la correspondencia entre el kardex
 * y el stock, que es justamente lo que el módulo garantiza. Para corregir un
 * saldo se usa `POST /api/inventario/insumos/:id/ajuste`.
 */
export class UpdateInsumoDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  nombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  descripcion?: string;

  @IsOptional()
  @IsEnum(UnidadInsumo)
  unidad?: UnidadInsumo;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stockMinimo?: number;
}
