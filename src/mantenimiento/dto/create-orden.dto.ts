import { OrigenOT, PrioridadOT, TipoOT } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import { CreateTareaDto } from './create-tarea.dto';

export class CreateOrdenDto {
  @IsString()
  @IsNotEmpty()
  equipoId!: string;

  @IsString()
  @IsNotEmpty()
  titulo!: string;

  @IsOptional()
  @IsEnum(PrioridadOT)
  prioridad?: PrioridadOT;

  @IsOptional()
  @IsEnum(TipoOT)
  tipo?: TipoOT;

  @IsOptional()
  @IsEnum(OrigenOT)
  origen?: OrigenOT;

  @IsOptional()
  @IsString()
  origenDetalle?: string;

  @IsOptional()
  @IsString()
  asignadoAId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTareaDto)
  tareas?: CreateTareaDto[];
}
