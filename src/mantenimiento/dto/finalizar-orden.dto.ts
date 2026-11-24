import { EquipmentStatus } from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { IntervencionBaseDto } from './create-intervencion.dto';

/**
 * «Finalizar tarea» en UN solo request: la intervención del cierre (qué se
 * hizo, insumos, foto) más cómo queda la orden (estado del equipo y lectura
 * de la mantención). Antes eran dos escrituras (POST intervención + PATCH
 * orden) y, si la segunda se rechazaba, la intervención y el descuento de
 * stock quedaban hechos con la orden todavía EN_PROCESO.
 */
export class FinalizarOrdenDto extends IntervencionBaseDto {
  /** UUID v4 del cliente: es el id de la intervención y la clave de
   * idempotencia del reenvío offline. Obligatorio: sin él un reintento no
   * podría distinguirse de un segundo cierre. */
  @IsUUID('4')
  id!: string;

  /** Cómo queda la unidad al cerrar (mismo campo que `UpdateOrdenDto`). */
  @IsOptional()
  @IsEnum(EquipmentStatus)
  equipmentStatus?: EquipmentStatus;

  /** Horómetro o km del equipo cuando se hizo la mantención: el ancla desde
   * la que se cuenta la próxima (misma validación que `UpdateOrdenDto`). */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  lecturaMantencion?: number;
}
