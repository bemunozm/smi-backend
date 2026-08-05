import { EstadoActividad } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateActividadDto {
  @IsEnum(EstadoActividad)
  estado!: EstadoActividad;
}
