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

  /**
   * Fecha elegida explícitamente, que gana sobre `capturedAt`. Dos formas:
   * con hora (panel del admin, `resolveRecordDate`: solo no puede ser
   * futura) o `YYYY-MM-DD` a secas (carga histórica de Terreno: misma
   * ventana de 30 días de las tarjetas y se guarda DENTRO de ese día de
   * negocio chileno — un date-only por `new Date()` caería a medianoche UTC,
   * o sea las ~21:00 del día ANTERIOR en Chile).
   */
  @IsOptional()
  @IsDateString()
  fecha?: string;

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
