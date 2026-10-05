import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateUmbralDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @IsString()
  @IsNotEmpty()
  tipoEquipo!: string;

  @IsString()
  @IsNotEmpty()
  tipoMantencion!: string;

  @IsInt()
  @Min(1)
  umbralHoras!: number;
}
