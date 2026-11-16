import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
} from 'class-validator';

import { formatNumber } from '../../../common/format/number';
import { ADBLUE_MAX_LITERS } from '../../../shifts/adblue';
import { TMP_KEY_REGEX } from '../../../storage/storage-keys';

/** Mensaje compartido con la corrección (`UpdateCombustibleDto`). */
export const ADBLUE_MAX_MESSAGE = `El AdBlue no puede superar los ${formatNumber(ADBLUE_MAX_LITERS)} L`;

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

  /** Lectura del contador del equipo al cargar: horómetro (h) en pesados,
   * kilometraje (km) en livianos — ver el comentario de la columna en el
   * schema. Opcional: Terreno no la manda (su lectura vive en la tarjeta). */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  lectura?: number;

  /** AdBlue cargado junto con esta carga, en litros, si se cargó. Mismo tope
   * que el AdBlue del cierre de tarjeta (`ADBLUE_MAX_LITERS`). Lo manda solo
   * el alta manual del panel: el AdBlue de Terreno viaja en la tarjeta. */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(ADBLUE_MAX_LITERS, { message: ADBLUE_MAX_MESSAGE })
  adBlueLitros?: number;
}
