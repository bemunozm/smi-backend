import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** Body de `PATCH /horometro/:id/salida` — cierra el turno abierto por `create()`. */
export class SalidaHorometroDto {
  /** UUID v4 del cierre: un reintento con el mismo id sobre una tarjeta ya
   * cerrada por esa misma solicitud responde 200 en vez de 409. */
  @IsOptional()
  @IsUUID('4')
  closeClientId?: string;

  /** Hora del DISPOSITIVO al registrar la salida — ver `capture-time.ts`.
   * Es `fechaSalida`; sin ella, la hora del servidor. */
  @IsOptional()
  @IsDateString()
  capturedAt?: string;

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
