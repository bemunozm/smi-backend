import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
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
  /** UUID v4 generado por el cliente: PK del asiento de ajuste, para que el
   * reenvío offline del mismo conteo no lo duplique. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @IsString()
  @MinLength(1)
  branchId!: string;

  /** Cantidad real contada. El sistema calcula la diferencia contra su saldo. */
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  countedQuantity!: number;

  /**
   * Existencia que quien contó veía en el sistema. Si otro movimiento la
   * cambió mientras contaba, el conteo se rechaza (409 `STALE_UPDATE`).
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  expectedQuantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  notes?: string;
}
