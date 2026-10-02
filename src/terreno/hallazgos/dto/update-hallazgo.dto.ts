import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Edición de un hallazgo ya registrado (Acta N.° 004, R13): corrige un error
 * humano —el equipo equivocado, una prioridad mal elegida, una descripción a
 * medias— sin autorización previa, pero con registro de quién cambió qué. Se
 * manda solo lo que cambió.
 *
 * La foto no se edita acá: es el respaldo de lo que se vio en terreno, y
 * reemplazarla pasa por el flujo de subida a storage privado.
 */
export class UpdateHallazgoDto {
  @IsOptional()
  @IsString()
  equipoId?: string;

  @IsOptional()
  @IsString()
  @MinLength(3, { message: 'Describí el hallazgo' })
  descripcion?: string;

  @IsOptional()
  @IsIn(['BAJA', 'MEDIA', 'ALTA', 'CRITICA'])
  prioridad?: string;

  @IsOptional()
  @IsIn(['ABIERTO', 'EN_PROCESO', 'CERRADO'])
  estado?: string;
}
