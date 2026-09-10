import { TipoInsumo, UnidadInsumo } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const normalizarCodigo = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateInsumoDto {
  @Transform(normalizarCodigo)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  nombre!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  descripcion?: string;

  @IsOptional()
  @IsEnum(UnidadInsumo)
  unidad?: UnidadInsumo;

  /** Suministro (consumible) o repuesto (pieza). Por defecto, suministro. */
  @IsOptional()
  @IsEnum(TipoInsumo)
  tipo?: TipoInsumo;

  /**
   * Stock inicial. Se acepta acá por comodidad al dar de alta el insumo; a
   * partir de ese momento el stock SOLO se mueve con movimientos de inventario
   * (no es editable desde `PATCH`), para que el kardex nunca quede descuadrado.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stock?: number;

  /**
   * Bodega que recibe el stock inicial. Sin ella, entra a la sucursal
   * principal: dar de alta un insumo sin decir dónde está es el caso común
   * cuando la empresa opera con una sola bodega.
   */
  @IsOptional()
  @IsString()
  sucursalId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stockMinimo?: number;
}
