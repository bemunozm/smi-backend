import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { TMP_KEY_REGEX } from '../../../storage/storage-keys';

export class CreateHallazgoDto {
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
   * `fotoUrl` (legacy, URL servida por `/api/uploads`) YA NO es un campo de
   * este DTO — se retiró en el cierre de R2 (RFC Supervisión en Terreno):
   * `/api/uploads` se eliminó por completo. La columna y el mapeo
   * de LECTURA (`FichaService.resolveHallazgoFotoUrls`,
   * `HallazgosService.shape`) siguen intactos para que los hallazgos viejos
   * con ese valor sigan renderizando (aunque el link quede roto). Cualquier
   * request que mande `fotoUrl` ahora se rechaza con 400
   * (`forbidNonWhitelisted`).
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(TMP_KEY_REGEX)
  fotoKey?: string;
}
