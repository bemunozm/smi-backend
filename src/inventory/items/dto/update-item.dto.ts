import { ItemType, UnitOfMeasure } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Edición de la ficha del ítem. **No incluye existencias a propósito**: el
 * saldo solo se mueve con movimientos (entrada, salida o ajuste por conteo).
 * Permitir editarlo a mano rompería la correspondencia entre el kardex y la
 * existencia, que es justo lo que el módulo garantiza. Para corregir un saldo
 * se usa `POST /api/inventory/items/:id/adjust`.
 *
 * `sku` tampoco: es la referencia con la que el catálogo aparece en el kardex
 * histórico, y renombrarla dejaría los reportes viejos hablando de otro código.
 */
export class UpdateItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @IsOptional()
  @IsEnum(UnitOfMeasure)
  unit?: UnitOfMeasure;

  @IsOptional()
  @IsEnum(ItemType)
  type?: ItemType;

  /**
   * `null` desvincula el ítem de su categoría; omitirlo la deja como está. Sin
   * esa distinción no habría forma de sacarle la categoría a un ítem mal
   * clasificado: un formulario que siempre omite el campo vacío solo puede
   * reclasificar, nunca limpiar.
   */
  @IsOptional()
  @ValidateIf((dto: UpdateItemDto) => dto.categoryId !== null)
  @IsString()
  categoryId?: string | null;

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

  /** Baja lógica: lo saca de los selectores sin perder su kardex. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
