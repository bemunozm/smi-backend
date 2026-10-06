import { OrigenOT, PrioridadOT, TipoOT } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

import { CreateTareaDto } from './create-tarea.dto';

export class CreateOrdenDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @IsString()
  @IsNotEmpty()
  equipoId!: string;

  /** Hallazgo de Terreno que origina la operación: al crearla, el hallazgo
   * pasa a EN_PROCESO en la misma transacción. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  hallazgoId?: string;

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
