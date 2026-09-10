import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Edición de la ficha de la bodega. **`codigo` no está acá a propósito**: es la
 * referencia que usa la operación para nombrar la bodega y aparece en el kardex
 * histórico; renombrarlo dejaría los reportes viejos hablando de una sucursal
 * que ya no se llama así. Si de verdad hay que cambiarlo, se crea otra.
 */
export class UpdateSucursalDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  nombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  direccion?: string;

  @IsOptional()
  @IsBoolean()
  activa?: boolean;

  @IsOptional()
  @IsBoolean()
  esPrincipal?: boolean;
}
