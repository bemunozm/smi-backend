import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateBranchDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
