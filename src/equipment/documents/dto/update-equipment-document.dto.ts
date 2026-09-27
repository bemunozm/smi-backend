import { EquipmentDocumentType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { TMP_KEY_REGEX } from '../../../storage/storage-keys';

/**
 * Edición de un documento. `type` no es nullable (es un campo requerido del
 * modelo) — solo se puede cambiar a otro valor del enum, no limpiar. El resto
 * es nullable a propósito, mismo criterio que `UpdateEquipmentDto.licensePlate`:
 * `@IsOptional()` deja pasar `null` sin correr el resto de los validadores,
 * así que alcanza con ensanchar el tipo — omitir la propiedad deja el campo
 * intacto, `null` explícito lo limpia.
 */
export class UpdateEquipmentDocumentDto {
  @IsOptional()
  @IsEnum(EquipmentDocumentType)
  type?: EquipmentDocumentType;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string | null;

  @IsOptional()
  @IsDateString()
  expiryDate?: string | null;

  /**
   * Tri-state (ver Diseño del RFC R2-storage, "Contrato de la API"):
   * `undefined` deja el archivo intacto, `null` lo borra, un string es la
   * key `tmp/<userId>/<uuid>.<ext>` de un archivo nuevo — mismo criterio que
   * `CreateEquipmentDocumentDto.fileKey`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(TMP_KEY_REGEX)
  fileKey?: string | null;

  /** Nullable a propósito (ver comentario de `fileKey`). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
