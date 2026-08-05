import { EstadoEquipo } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Normaliza el código de la unidad: es la clave de negocio (patente / ID
 * interno) y además es `@unique`. Sin esto, "ex-001" y "EX-001" entran como dos
 * equipos distintos y el operador en terreno termina cargando horómetro en la
 * máquina equivocada.
 */
const normalizarCodigo = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateEquipoDto {
  @Transform(normalizarCodigo)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  tipo!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  marca!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  modelo!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1950)
  @Max(2100)
  anio?: number;

  @IsOptional()
  @IsEnum(EstadoEquipo)
  estado?: EstadoEquipo;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  horometroActual?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  kilometrajeActual?: number;
}
