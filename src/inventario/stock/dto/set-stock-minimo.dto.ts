import { Type } from 'class-transformer';
import { IsNumber, IsString, Min } from 'class-validator';

/**
 * Body de `PUT /api/inventario/stock/minimo`. Define el umbral de reposición
 * propio de una bodega. `0` significa "esta bodega no fija uno propio" y el
 * cálculo cae al mínimo global del insumo (ver `StockService`).
 */
export class SetStockMinimoDto {
  @IsString()
  insumoId!: string;

  @IsString()
  sucursalId!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stockMinimo!: number;
}
