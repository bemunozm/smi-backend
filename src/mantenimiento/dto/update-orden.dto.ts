import { EstadoOT, PrioridadOT } from '@prisma/client';
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
}
