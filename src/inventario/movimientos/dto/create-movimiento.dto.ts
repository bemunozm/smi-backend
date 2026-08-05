import { OrigenMovimiento, TipoMovimiento } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Movimiento manual desde la pantalla de Inventario (recepción de compra,
 * devolución a bodega, salida directa de material).
 *
 * `responsableId` NO está en el body a propósito: sale de la sesión de Better
 * Auth en el controller. Si viniera del cliente, cualquiera podría imputarle
 * un consumo a otra persona y la trazabilidad dejaría de valer.
 */
export class CreateMovimientoDto {
  @IsString()
  insumoId!: string;

  @IsEnum(TipoMovimiento)
  tipo!: TipoMovimiento;

  @IsEnum(OrigenMovimiento)
  origen!: OrigenMovimiento;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  cantidad!: number;

  /** Equipo al que se imputa el consumo, si aplica. */
  @IsOptional()
  @IsString()
  equipoId?: string;

  /** Id del documento de origen (intervención, actividad…). */
  @IsOptional()
  @IsString()
  referenciaId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  observacion?: string;
}
