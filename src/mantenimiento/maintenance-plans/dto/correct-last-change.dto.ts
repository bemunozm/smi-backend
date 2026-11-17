import { TipoOT } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { IsDateOnly } from '../../../shifts/date-only';

/** Recorta el texto antes de validar: un título en blanco no pasa
 * `@IsNotEmpty`. Lo que no es texto llega tal cual a `@IsString`. */
const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `PATCH /maintenance-plans/:equipmentId/last-change` — el administrador
 * corrige desde la pizarra el último cambio con los mismos datos con que se
 * registra una mantención anterior (`CreateMantencionHistoricaDto`): fecha,
 * lectura, hito y, si el cambio tiene una orden ligada, sus datos (título,
 * tipo, quién la hizo y observaciones). Mismos topes que esa alta.
 */
export class CorrectLastChangeDto {
  /** `YYYY-MM-DD` del cambio. El servicio exige que no sea futura. */
  @IsDateOnly()
  doneAt!: string;

  /** Horómetro o kilometraje del equipo al hacerlo (mismos topes que la
   * lectura de una mantención anterior). */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  counterAt!: number;

  /** Hito de la pauta que se hizo (o el servicio inicial). Solo en un equipo
   * con pauta: cambiarlo reemplaza los registros del cambio. */
  @IsOptional()
  @IsInt()
  @Min(1)
  milestone?: number;

  /** CORRECTIVA: deja de contar como cambio (solo una mantención anterior). */
  @IsOptional()
  @IsEnum(TipoOT)
  tipo?: TipoOT;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  titulo?: string;

  /** Quién la hizo (solo una mantención anterior). Vacío la deja sin nombre. */
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(120)
  realizadaPor?: string;

  /** Solo una mantención anterior. Vacío las borra. */
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(1000)
  observaciones?: string;
}
