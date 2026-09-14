import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Body de `POST /api/inventory/stock/transfer` — mover existencia de una bodega
 * a otra.
 *
 * El traspaso NO es un asiento con dos sucursales: son **dos** asientos (salida
 * en el origen + entrada en el destino) que comparten `reference` y llevan
 * `reason = TRANSFER` (RFC-3 D4). Así el saldo de cada bodega se deriva leyendo
 * únicamente sus propios asientos, sin tener que interpretar el signo según de
 * qué lado se mire.
 */
export class TransferStockDto {
  @IsString()
  @MinLength(1)
  itemId!: string;

  @IsString()
  @MinLength(1)
  sourceBranchId!: string;

  @IsString()
  @MinLength(1)
  destinationBranchId!: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  quantity!: number;

  /** Guía de despacho del traspaso; queda en los dos asientos. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  documentNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  notes?: string;
}
