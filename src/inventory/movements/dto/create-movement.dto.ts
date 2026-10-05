import { MovementDirection, MovementReason } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { MANUAL_MOVEMENT_REASONS } from '../movement-reasons';

/**
 * Movimiento manual desde la pantalla de Inventario: recepción de compra,
 * devolución a bodega, o salida directa de material.
 *
 * `performedById` NO está en el body a propósito: sale de la sesión de Better
 * Auth en el controller. Si viniera del cliente, cualquiera podría imputarle un
 * consumo a otra persona y la trazabilidad dejaría de valer.
 *
 * Los traspasos entre sucursales y los ajustes por conteo físico NO se
 * registran acá: el traspaso son dos asientos en una sola transacción y el
 * ajuste se calcula contra el saldo vigente, así que cada uno va por su propio
 * endpoint. `reason` rechaza los motivos reservados para ellos.
 */
export class CreateMovementDto {
  /** UUID v4 generado por el cliente: PK del movimiento y clave de
   * idempotencia para el reenvío offline. Opcional para no romper a un
   * cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

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
  @IsIn(MANUAL_MOVEMENT_REASONS, {
    message:
      'reason no admite TRANSFER ni PHYSICAL_ADJUSTMENT: nacen de su propio endpoint',
  })
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
  @MaxLength(120)
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
