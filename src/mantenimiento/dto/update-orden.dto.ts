import { EquipmentStatus, EstadoOT, PrioridadOT } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

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
}
