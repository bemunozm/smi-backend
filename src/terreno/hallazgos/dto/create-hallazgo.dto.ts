import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

import { TMP_KEY_REGEX } from '../../../storage/storage-keys';

export class CreateHallazgoDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  /** Hora del DISPOSITIVO al registrar el hallazgo — ver `capture-time.ts`. */
  @IsOptional()
  @IsDateString()
  capturedAt?: string;

  @IsString()
  equipoId!: string;

  @IsString()
  descripcion!: string;

  @IsIn(['BAJA', 'MEDIA', 'ALTA', 'CRITICA'])
  prioridad!: string;

  /**
   * Key `tmp/<userId>/<uuid>.<ext>` de una foto recién subida por
   * `POST /api/files`. El DTO valida solo la FORMA — el servicio valida la
   * pertenencia vía `StorageService.claimTmp`.
   *
   * `fotoUrl` no se acepta: la foto entra solo por `fotoKey` (subida previa
   * a `tmp/`); un cliente que la mande recibe 400 (`forbidNonWhitelisted`).
   * La columna y el mapeo de LECTURA (`FichaService.resolveHallazgoFotoUrls`,
   * `HallazgosService.shape`) se mantienen para que los hallazgos viejos con
   * ese valor sigan renderizando.
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(TMP_KEY_REGEX)
  fotoKey?: string;
}
