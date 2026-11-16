import { EquipmentStatus, EstadoOT, PrioridadOT } from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpdateOrdenDto {
  @IsOptional()
  @IsEnum(EstadoOT)
  estado?: EstadoOT;

  @IsOptional()
  @IsString()
  asignadoAId?: string;

  @IsOptional()
  @IsEnum(PrioridadOT)
  prioridad?: PrioridadOT;

  @IsOptional()
  @IsString()
  titulo?: string;

  /** Cómo queda la unidad al cerrar ("Finalizar tarea") — solo se acepta
   * junto a `estado: COMPLETADA`; fuera de ese cruce el servicio responde 400. */
  @IsOptional()
  @IsEnum(EquipmentStatus)
  equipmentStatus?: EquipmentStatus;

  /** Horómetro o km del equipo cuando se hizo la mantención. Solo se
   * informa al completar la orden: pasa a ser el ancla desde la que se
   * cuenta la próxima. Sin ella vale la lectura actual del equipo. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  lecturaMantencion?: number;
}
