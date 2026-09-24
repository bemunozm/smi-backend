import { IsDateString, IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class CreateCombustibleDto {
  @IsString()
  equipoId!: string;

  @IsNumber()
  @IsPositive()
  litros!: number;

  @IsIn(['PETROLEO', 'BENCINA'])
  tipo!: string;

  @IsOptional()
  @IsString()
  fotoUrl?: string;

  /** Fecha de carga (auto-rellenada en el cliente desde la EXIF de la foto,
   * editable). Opcional: si no viene, `RegistroCombustible.fecha` cae al
   * `@default(now())` del schema (comportamiento previo intacto). */
  @IsOptional()
  @IsDateString()
  fecha?: string;
}
