import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { normalizeObservaciones } from '../../../common/normalize-observaciones';
import { SHIFT_TYPES, type ShiftType } from '../../../shifts/shift-type';
import { ACTIVIDADES } from './create-trabajo-extra.dto';

/**
 * Edición de un trabajo ya registrado (Acta N.° 004, R13): se puede cambiar
 * cualquier dato, sin autorización previa. Cada campo es opcional —se manda
 * solo lo que cambió— y valida igual que al crear. Las reglas que cruzan
 * campos (final ≥ inicial, «Otro» con texto) las aplica el servicio sobre el
 * registro ya combinado, no sobre lo que vino en el body.
 *
 * El operador se cambia por `operatorId` (catálogo), igual que al crear: el
 * nombre (`operador`) lo deriva el servidor, y mandarlo en el body es un 400.
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
  @IsNotEmpty()
  operatorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  faena?: string;

  @IsOptional()
  @IsIn(SHIFT_TYPES)
  turno?: ShiftType;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  horometroInicial?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
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
  @MaxLength(1000)
  descripcion?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeObservaciones(value))
  @IsString()
  @MaxLength(1000)
  observaciones?: string;
}
