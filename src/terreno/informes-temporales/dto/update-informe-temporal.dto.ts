import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { normalizeObservaciones } from '../../../common/normalize-observaciones';
import { IsDateOnly } from '../../../shifts/date-only';
import { SHIFT_TYPES, type ShiftType } from '../../../shifts/shift-type';
import {
  MAX_PERSONAL_POR_ACTIVIDAD,
  PersonalInformeDto,
} from './create-informe-temporal.dto';

/**
 * `PATCH /api/informes-temporales/:id` — corrección de un informe ya enviado.
 * Los mismos campos que al crear, todos opcionales, SIN `id` ni `cierres`: las
 * lecturas y litros de cada tarjeta se corrigen con `PATCH /shift-cards/:id`.
 * Las reglas que cruzan campos (personal vs. actividad 2) las valida el
 * servicio sobre el informe ya combinado.
 */
export class UpdateInformeTemporalDto {
  @IsOptional()
  @IsDateOnly()
  fecha?: string;

  @IsOptional()
  @IsIn(SHIFT_TYPES)
  turno?: ShiftType;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  actividad1?: string;

  /** Vacío = quitar la actividad 2. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  actividad2?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2 * MAX_PERSONAL_POR_ACTIVIDAD)
  @ValidateNested({ each: true })
  @Type(() => PersonalInformeDto)
  personal?: PersonalInformeDto[];

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeObservaciones(value))
  @IsString()
  @MaxLength(1000)
  observaciones?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  supervisorResponsable1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  supervisorResponsable2?: string;

  @IsOptional()
  @IsBoolean()
  fotosEnviadas?: boolean;

  @IsOptional()
  @IsBoolean()
  infoSubidaApp?: boolean;
}
