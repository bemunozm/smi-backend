import { ItemType, UnitOfMeasure } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const normalizeSku = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateItemDto {
  @Transform(normalizeSku)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @IsOptional()
  @IsEnum(UnitOfMeasure)
  unit?: UnitOfMeasure;

  /** Suministro (consumible) o repuesto (pieza). Por defecto, suministro. */
  @IsOptional()
  @IsEnum(ItemType)
  type?: ItemType;

  @IsOptional()
  @IsString()
  categoryId?: string;

  /** Número de parte del fabricante — lo que el mecánico lee en la pieza. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  partNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  defaultSupplier?: string;

  @IsOptional()
  @IsBoolean()
  isCritical?: boolean;

  /**
   * Existencia inicial. Se acepta al dar de alta por comodidad; a partir de ahí
   * el saldo SOLO se mueve con movimientos, para que el kardex nunca quede
   * descuadrado.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  initialQuantity?: number;

  /**
   * Bodega que recibe la existencia inicial. Obligatoria si `initialQuantity`
   * es mayor a 0: sin ella el saldo entraría en una bodega elegida por el
   * sistema y el descuadre aparecería recién en el conteo físico.
   */
  @ValidateIf((dto: CreateItemDto) => (dto.initialQuantity ?? 0) > 0)
  @IsString()
  @MinLength(1)
  branchId?: string;
}
