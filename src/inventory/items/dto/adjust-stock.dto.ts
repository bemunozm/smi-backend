import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Body de `POST /api/inventory/items/:id/adjust` — conteo físico de una bodega.
 *
 * `branchId` es obligatorio: un conteo físico siempre ocurre EN un lugar. Sin
 * él habría que compararlo contra el total de la empresa, que registraría como
 * faltante todo lo que está guardado en otra sucursal.
 */
export class AdjustStockDto {
  @IsString()
  @MinLength(1)
  branchId!: string;

  /** Cantidad real contada. El sistema calcula la diferencia contra su saldo. */
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  countedQuantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  notes?: string;
}
