import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  ValidateNested,
} from 'class-validator';

import { normalizeObservaciones } from '../../../common/normalize-observaciones';
import { SHIFT_TYPES, type ShiftType } from '../../../shifts/shift-type';
import { ACTIVIDADES, ActividadDetalleDto } from './create-trabajo-extra.dto';

/**
 * Edición de un trabajo ya registrado: se puede cambiar
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

  /** N° del report en papel. Editable (corregir un folio mal tipeado); no se
   * puede dejar vacío. */
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Indicá el número del report' })
  @MaxLength(30)
  reportNumero?: string;

  /** Desglose por actividad (reemplaza COMPLETO al vigente cuando viene).
   * Las reglas por fila (PLANTA ⇒ limpieza de silos y nombre de planta) las
   * aplica el servicio; `actividades` se re-deriva de acá. */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'Agregá al menos una actividad' })
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => ActividadDetalleDto)
  detalle?: ActividadDetalleDto[];

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeObservaciones(value))
  @IsString()
  @MaxLength(1000)
  observaciones?: string;
}
