import { OrigenActividad } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateActividadDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

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
