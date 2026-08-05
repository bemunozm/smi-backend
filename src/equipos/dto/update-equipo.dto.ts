import { EstadoEquipo } from '@prisma/client';
import { Type } from 'class-transformer';
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
 * Edición de la ficha del equipo (ADMIN). El `codigo` NO es editable a
 * propósito: es la clave de negocio con la que terreno, mantenimiento e
 * inventario referencian la máquina; renombrarla rompería la trazabilidad de
 * registros ya cargados. Si un equipo se dio de alta con el código equivocado,
 * se da de baja y se crea de nuevo.
 */
export class UpdateEquipoDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  tipo?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  marca?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  modelo?: string;

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

/**
 * Body de `PATCH /api/equipos/:id/estado`. Endpoint aparte del PATCH general
 * porque tiene otros permisos: el SUPERVISOR actualiza el estado de la flota
 * desde terreno (requerimientos §5.2, "Control de Flota") pero no edita la
 * ficha técnica.
 */
export class UpdateEstadoEquipoDto {
  @IsEnum(EstadoEquipo)
  estado!: EstadoEquipo;
}
