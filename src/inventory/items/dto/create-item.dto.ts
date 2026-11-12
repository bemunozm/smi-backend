import { ItemType, UnitOfMeasure } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  Max,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const normalizeSku = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/**
 * Unidades que se cuentan por pieza y pueden declarar su contenido: la unidad
 * suelta y los envases (tineta, bidón, tambor, caja).
 */
export const PACKAGED_UNITS: UnitOfMeasure[] = [
  UnitOfMeasure.UNIT,
  UnitOfMeasure.PAIL,
  UnitOfMeasure.CAN,
  UnitOfMeasure.DRUM,
  UnitOfMeasure.BOX,
];

/**
 * En qué se puede medir ese contenido. «Unidades» solo vale para un envase
 * (una caja de 12 filtros); en un ítem contado en unidades se descarta.
 */
export const CONTENT_UNITS: UnitOfMeasure[] = [
  UnitOfMeasure.LITER,
  UnitOfMeasure.KILOGRAM,
  UnitOfMeasure.METER,
  UnitOfMeasure.UNIT,
];

/**
 * Qué medida admite el contenido según la forma de contar (la primera es la
 * que se toma si no viene): una unidad en litros, kilos o metros; tineta,
 * bidón y tambor en litros o kilos; una caja en unidades o kilos. Es la misma
 * tabla que ofrece el formulario del frontend.
 */
export const CONTENT_UNITS_BY_UNIT: Partial<
  Record<UnitOfMeasure, UnitOfMeasure[]>
> = {
  [UnitOfMeasure.UNIT]: [
    UnitOfMeasure.LITER,
    UnitOfMeasure.KILOGRAM,
    UnitOfMeasure.METER,
  ],
  [UnitOfMeasure.PAIL]: [UnitOfMeasure.LITER, UnitOfMeasure.KILOGRAM],
  [UnitOfMeasure.CAN]: [UnitOfMeasure.LITER, UnitOfMeasure.KILOGRAM],
  [UnitOfMeasure.DRUM]: [UnitOfMeasure.LITER, UnitOfMeasure.KILOGRAM],
  [UnitOfMeasure.BOX]: [UnitOfMeasure.UNIT, UnitOfMeasure.KILOGRAM],
};

export class CreateItemDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  /** Código interno. Opcional: sin él, el servicio genera uno (`SUM-0001`). */
  @IsOptional()
  @Transform(normalizeSku)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  sku?: string;

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

  /**
   * Contenido de cada unidad (ej. 10 para un bidón de 10 L). Solo aplica si el
   * ítem se cuenta en unidades; con litros, kilos o metros se ignora.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El contenido por unidad tiene que ser un número.' })
  @Min(0.001, { message: 'El contenido por unidad tiene que ser mayor a 0.' })
  @Max(100_000, {
    message: 'El contenido por unidad no puede superar 100.000.',
  })
  contentPerUnit?: number;

  /** En qué se mide ese contenido: litros, kilos o metros. */
  @IsOptional()
  @IsIn(CONTENT_UNITS, {
    message: 'El contenido se mide en litros, kilos, metros o unidades.',
  })
  contentUnit?: UnitOfMeasure;

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
