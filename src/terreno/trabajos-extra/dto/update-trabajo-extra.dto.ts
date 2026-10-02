import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { ACTIVIDADES } from './create-trabajo-extra.dto';

/**
 * Edición de un trabajo ya registrado (Acta N.° 004, R13): se puede cambiar
 * cualquier dato, sin autorización previa. Cada campo es opcional —se manda
 * solo lo que cambió— y valida igual que al crear. Las reglas que cruzan
 * campos (final ≥ inicial, «Otro» con texto) las aplica el servicio sobre el
 * registro ya combinado, no sobre lo que vino en el body.
 *
 * Lo que no se edita: `totalHoras` (se recalcula) y `fecha` (es cuándo se
 * registró, y es parte de lo que la trazabilidad tiene que conservar).
 */
export class UpdateTrabajoExtraDto {
  @IsOptional()
  @IsString()
  equipoId?: string;

  @IsOptional()
  @IsString()
  operador?: string;

  @IsOptional()
  @IsString()
  faena?: string;

  @IsOptional()
  @IsIn(['DIURNO', 'NOCTURNO'])
  turno?: string;

  @IsOptional()
  @IsNumber()
  horometroInicial?: number;

  @IsOptional()
  @IsNumber()
  horometroFinal?: number;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'Elegí al menos una actividad' })
  @IsIn([...ACTIVIDADES], { each: true })
  actividades?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  otraActividad?: string;

  @IsOptional()
  @IsString()
  descripcion?: string;

  @IsOptional()
  @IsString()
  observaciones?: string;
}
