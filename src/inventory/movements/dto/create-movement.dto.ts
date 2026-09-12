import { MovementDirection, MovementReason } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Movimiento manual desde la pantalla de Inventario: recepción de compra,
 * devolución a bodega, o salida directa de material.
 *
 * `performedById` NO está en el body a propósito: sale de la sesión de Better
 * Auth en el controller. Si viniera del cliente, cualquiera podría imputarle un
 * consumo a otra persona y la trazabilidad dejaría de valer.
 *
 * Los traspasos entre sucursales NO se registran acá: son dos asientos que
 * tienen que ocurrir en una sola transacción y van por su propio endpoint.
 */
export class CreateMovementDto {
  @IsString()
  @MinLength(1)
  itemId!: string;

  /** Bodega cuyo saldo se mueve. Obligatoria. */
  @IsString()
  @MinLength(1)
  branchId!: string;

  @IsEnum(MovementDirection)
  direction!: MovementDirection;

  @IsEnum(MovementReason)
  reason!: MovementReason;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  quantity!: number;

  /** Equipo al que se imputa el consumo, si aplica. */
  @IsOptional()
  @IsString()
  equipmentId?: string;

  /** Vínculo interno con lo que originó el movimiento (intervención,
   *  actividad…). NO es el número de guía: ese va en `documentNumber`. */
  @IsOptional()
  @IsString()
  reference?: string;

  /** Guía de despacho, orden de compra o factura que respalda el movimiento. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  documentNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  notes?: string;
}
