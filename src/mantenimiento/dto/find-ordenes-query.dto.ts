import { EstadoOT } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class FindOrdenesQueryDto {
  @IsOptional()
  @IsEnum(EstadoOT)
  estado?: EstadoOT;
}
