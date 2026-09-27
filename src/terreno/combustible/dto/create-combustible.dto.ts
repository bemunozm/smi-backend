import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { TMP_KEY_REGEX } from '../../../storage/storage-keys';

export class CreateCombustibleDto {
  @IsString()
  equipoId!: string;

  @IsNumber()
  @IsPositive()
  litros!: number;

  @IsIn(['PETROLEO', 'BENCINA'])
  tipo!: string;

  /**
   * Legacy: URL servida por `/api/uploads` (Terreno, sigue viva — ver
   * Diseño del RFC R2-storage, "Combustible"). Mutuamente excluyente con
   * `fotoKey`: `CombustibleService` rechaza con 400 si llegan los dos.
   *
   * Restringida a una ruta relativa `/uploads/<archivo>` propia (hallazgo
   * BAJO B3 de la revisión de seguridad, código de Terreno): sin este
   * `@Matches`, cualquier string pasaba, y una URL externa (`https://evil.com/
   * pixel.png`) quedaba guardada y se renderizaba tal cual como `<img src>`
   * en el listado — un tracking pixel disfrazado de foto de carga.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Matches(/^\/uploads\/[\w.-]+$/)
  fotoUrl?: string;

  /**
   * Key `tmp/<userId>/<uuid>.<ext>` de una foto recién subida por
   * `POST /api/files`, ADITIVA sobre `fotoUrl` legacy. El DTO valida solo la
   * FORMA — `CombustibleService` valida ownership (vía
   * `StorageService.claimTmp`) y que no venga junto con `fotoUrl`.
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
