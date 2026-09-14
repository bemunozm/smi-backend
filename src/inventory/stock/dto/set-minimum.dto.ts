import { Type } from 'class-transformer';
import { IsNumber, IsString, Min, MinLength } from 'class-validator';

/**
 * Body de `PUT /api/inventory/stock/minimum` — umbral de reposición propio de
 * una bodega.
 *
 * `0` es un valor válido y significa "esta bodega no fija umbral": deja de
 * alertar. No se hereda el mínimo de la empresa, que está calibrado sobre el
 * total y encendería la alerta en todas las filas a la vez.
 */
export class SetMinimumDto {
  @IsString()
  @MinLength(1)
  itemId!: string;

  @IsString()
  @MinLength(1)
  branchId!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minimumQuantity!: number;
}
