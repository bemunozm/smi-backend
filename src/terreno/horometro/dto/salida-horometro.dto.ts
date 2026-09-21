import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Body de `PATCH /horometro/:id/salida` — cierra el turno abierto por `create()`. */
export class SalidaHorometroDto {
  @IsNumber()
  @Min(0)
  valorFinal!: number;

  @IsOptional()
  @IsString()
  fotoUrlSalida?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  nivelCombustible?: number;
}
