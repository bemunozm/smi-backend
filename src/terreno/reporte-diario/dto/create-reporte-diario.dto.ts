import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { IsDateOnly } from '../../../shifts/date-only';
import { SHIFT_TYPES, type ShiftType } from '../../../shifts/shift-type';

export const SECCIONES = ['INTERNOS', 'MINA_CALETA', 'MINERAS'] as const;

/** Cómo se lee cada sección en pantalla y en el registro de cambios. */
export const SECCION_LABEL: Record<string, string> = {
  INTERNOS: 'Camiones internos',
  MINA_CALETA: 'Camiones Mina Caleta',
  MINERAS: 'Camiones mineras',
};

export const TRASPASO_TIPOS = ['INTERNOS', 'EXTERNOS', 'MINA_PUERTO'] as const;

export const TRASPASO_LABEL: Record<string, string> = {
  INTERNOS: 'Equipos internos',
  EXTERNOS: 'Equipos externos',
  MINA_PUERTO: 'Equipos Mina-Puerto',
};

export class ProduccionTurnoDto {
  @IsIn(SECCIONES)
  seccion!: string;

  @IsInt()
  @Min(0)
  @Max(10_000)
  camiones!: number;

  /** Vueltas POR CAMIÓN de la sección, no el total ya multiplicado. */
  @IsInt()
  @Min(0)
  @Max(10_000)
  vueltasPorCamion!: number;
}

export class ReporteTolvaDto {
  @IsInt()
  @Min(1)
  @Max(3)
  tolva!: number;

  @IsInt()
  @Min(0)
  @Max(10_000)
  cargas!: number;
}

export class ReportePlantaDto {
  @IsString()
  @IsNotEmpty()
  plantaId!: string;

  /** Qué elaboró la planta en el turno — obligatorio si la planta operó. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  producto!: string;
}

export class ReporteTraspasoDto {
  @IsIn(TRASPASO_TIPOS)
  tipo!: string;

  @IsInt()
  @Min(0)
  @Max(10_000)
  cantidad!: number;
}

export class ReportePersonalDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  rol!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nombre!: string;
}

export class CreateReporteDiarioDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @IsDateOnly()
  fecha!: string;

  @IsIn(SHIFT_TYPES)
  turno!: ShiftType;

  /** Exactamente las 3 secciones; el service valida que no se repitan. */
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ProduccionTurnoDto)
  produccion!: ProduccionTurnoDto[];

  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ReporteTolvaDto)
  tolvas!: ReporteTolvaDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportePlantaDto)
  plantas!: ReportePlantaDto[];

  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ReporteTraspasoDto)
  traspasos!: ReporteTraspasoDto[];

  /** Ids de `EmpresaExterna` que operaron. Vacío = turno sin externos. */
  @IsArray()
  @IsString({ each: true })
  empresaIds!: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportePersonalDto)
  personal!: ReportePersonalDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observaciones?: string;
}
