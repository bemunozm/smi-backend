import { OrigenActividad } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateActividadDto {
  @IsString()
  @IsNotEmpty()
  descripcion!: string;

  @IsEnum(OrigenActividad)
  origen!: OrigenActividad;

  @IsOptional()
  @IsString()
  referencia?: string;

  @IsOptional()
  @IsString()
  asignadoAId?: string;

  @IsOptional()
  @IsString()
  equipoId?: string;

  @IsOptional()
  @IsString()
  hallazgoId?: string;
}
