import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { IsChileanRut } from './is-chilean-rut.validator';

export class CreateOperatorDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** Trimmed antes de validar — `OperatorsService` la normaliza al formato
   * canónico `12345678-K` al persistir. Opcional hasta que llegue la nómina
   * real del cliente con RUT. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsChileanRut()
  rut?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
