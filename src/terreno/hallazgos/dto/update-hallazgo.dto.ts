import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { HALLAZGO_FAENAS } from '../hallazgo-tipo';

/**
 * Edición de un hallazgo ya registrado: corrige un error
 * humano —el equipo equivocado, una prioridad mal elegida, una descripción a
 * medias— sin autorización previa, pero con registro de quién cambió qué. Se
 * manda solo lo que cambió.
 *
 * La foto no se edita acá: es el respaldo de lo que se vio en terreno, y
 * reemplazarla pasa por el flujo de subida a storage privado.
 *
 * El tipo (equipo o zona) no se cambia: el de equipo corrige `equipoId`, el
 * de zona `faena` y `lugar` (el servicio rechaza mezclarlos).
 */
export class UpdateHallazgoDto {
  @IsOptional()
  @IsString()
  equipoId?: string;

  @IsOptional()
  @IsIn(HALLAZGO_FAENAS)
  faena?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Escribe el lugar del hallazgo' })
  @MaxLength(120)
  lugar?: string;

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
