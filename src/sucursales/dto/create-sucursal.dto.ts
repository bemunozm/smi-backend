import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

const normalizarCodigo = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateSucursalDto {
  /** Identificador corto de la bodega (CENTRAL, NORTE…). Se normaliza a mayúsculas. */
  @Transform(normalizarCodigo)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  nombre!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  direccion?: string;

  /**
   * Marcar como bodega por defecto. El service desmarca la anterior en la
   * misma transacción: nunca hay dos principales ni cero.
   */
  @IsOptional()
  @IsBoolean()
  esPrincipal?: boolean;
}
