import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/** Body de `PATCH /horometro/:id/salida` — cierra el turno abierto por `create()`. */
export class SalidaHorometroDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  valorFinal!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  nivelCombustible?: number;
}
