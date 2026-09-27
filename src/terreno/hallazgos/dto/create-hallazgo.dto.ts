import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { TMP_KEY_REGEX } from '../../../storage/storage-keys';

export class CreateHallazgoDto {
  @IsString()
  equipoId!: string;

  @IsString()
  descripcion!: string;

  @IsIn(['BAJA', 'MEDIA', 'ALTA', 'CRITICA'])
  prioridad!: string;

  /**
   * Legacy: URL servida por `/api/uploads`. Mutuamente excluyente con
   * `fotoKey` — `HallazgosService` rechaza con 400 si llegan las dos.
   *
   * Restringida a una ruta relativa `/uploads/<archivo>` propia, igual que en
   * `CreateCombustibleDto`. Sin este `@Matches` cualquier string pasaba, y una
   * URL externa (`https://evil.com/pixel.png`) quedaba guardada y se
   * renderizaba tal cual como `<img src>` en el listado: un pixel de rastreo
   * disfrazado de foto de hallazgo. Combustible ya lo cerró; esto cierra el
   * mismo agujero acá.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Matches(/^\/uploads\/[\w.-]+$/)
  fotoUrl?: string;

  /**
   * Key `tmp/<userId>/<uuid>.<ext>` de una foto recién subida por
   * `POST /api/files`, ADITIVA sobre `fotoUrl` legacy. El DTO valida solo la
   * FORMA — el servicio valida la pertenencia vía `StorageService.claimTmp`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(TMP_KEY_REGEX)
  fotoKey?: string;
}
