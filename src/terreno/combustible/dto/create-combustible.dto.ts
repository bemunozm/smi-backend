import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

import { TMP_KEY_REGEX } from '../../../storage/storage-keys';

export class CreateCombustibleDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @IsString()
  equipoId!: string;

  @IsNumber()
  @IsPositive()
  litros!: number;

  @IsIn(['PETROLEO', 'BENCINA'])
  tipo!: string;

  /**
   * Key `tmp/<userId>/<uuid>.<ext>` de una foto recién subida por
   * `POST /api/files`. El DTO valida solo la FORMA — `CombustibleService`
   * valida ownership vía `StorageService.claimTmp`.
   *
   * `fotoUrl` no se acepta: la foto entra solo por `fotoKey` (subida previa
   * a `tmp/`); un cliente que la mande recibe 400 (`forbidNonWhitelisted`).
   * La columna y el mapeo de LECTURA en `CombustibleService.shape` se
   * mantienen para que las filas viejas con ese valor sigan renderizando.
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(TMP_KEY_REGEX)
  fotoKey?: string;

  /** Fecha de carga (auto-rellenada en el cliente desde la EXIF de la foto,
   * editable). Opcional: si no viene, `RegistroCombustible.fecha` cae al
   * `@default(now())` del schema (comportamiento previo intacto). */
  @IsOptional()
  @IsDateString()
  fecha?: string;
}
