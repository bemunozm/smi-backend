import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { normalizeObservaciones } from '../../../common/normalize-observaciones';
import { IsDateOnly } from '../../../shifts/date-only';
import { SHIFT_TYPES, type ShiftType } from '../../../shifts/shift-type';
import {
  MAX_PERSONAL_POR_ACTIVIDAD,
  PersonalInformeDto,
} from './create-informe-temporal.dto';

/** Tope de equipos de un informe en papel (el normal cierra hasta 20). */
export const MAX_EQUIPOS_INFORME = 20;

/**
 * Un equipo del informe en papel, escrito a mano: NO abre ni cierra tarjetas
 * ni mueve el contador del equipo. Final ≥ inicial lo valida el servicio.
 */
export class EquipoRegistradoDto {
  @IsString()
  @IsNotEmpty({ message: 'Elige el equipo.' })
  @MaxLength(64)
  equipoId!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10_000_000)
  inicial!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10_000_000)
  final!: number;

  /** Combustible cargado — opcional (`null` o ausente = sin dato). */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100_000)
  litros?: number | null;
}

/**
 * `POST /api/informes-temporales/antiguo` — «Subir informe antiguo»: un
 * informe en papel que se digitaliza después, sin tarjetas. Lo sube el propio
 * supervisor temporal (queda a su nombre) o la oficina (ADMIN/SECRETARIA, que
 * elige a qué supervisor temporal pertenece con `supervisorId`).
 */
export class CreateInformeAntiguoDto {
  /** UUID del cliente: el reintento offline es idempotente. */
  @IsUUID()
  id!: string;

  /** El N° del papel: tiene que estar libre entre los informes temporales. */
  @IsInt({ message: 'El N° del informe es un número entero.' })
  @Min(1, { message: 'El N° del informe tiene que ser mayor que 0.' })
  @Max(1_000_000)
  numero!: number;

  /** `YYYY-MM-DD`, pasado o hoy (hasta un año atrás). */
  @IsDateOnly()
  fecha!: string;

  @IsIn(SHIFT_TYPES)
  turno!: ShiftType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/\S/, { message: 'Escribe la actividad realizada.' })
  actividad1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  actividad2?: string;

  @IsArray()
  @ArrayMaxSize(2 * MAX_PERSONAL_POR_ACTIVIDAD)
  @ValidateNested({ each: true })
  @Type(() => PersonalInformeDto)
  personal!: PersonalInformeDto[];

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeObservaciones(value))
  @IsString()
  @MaxLength(1000)
  observaciones?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Matches(/\S/, { message: 'Escribe el supervisor responsable.' })
  supervisorResponsable1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  supervisorResponsable2?: string;

  /** Solo la oficina: a qué supervisor temporal pertenece. El supervisor
   * temporal no lo manda (el informe queda a su nombre). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  supervisorId?: string;

  /** Foto del report en papel (opcional): key `tmp/` de `POST /api/files`. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  fotoKey?: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Agrega al menos un equipo.' })
  @ArrayMaxSize(MAX_EQUIPOS_INFORME)
  @ValidateNested({ each: true })
  @Type(() => EquipoRegistradoDto)
  equipos!: EquipoRegistradoDto[];
}
