import { EquipmentDocumentType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

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
   * Solo acepta rutas internas de uploads — nunca un dominio externo
   * arbitrario, que abriría el link "Ver/descargar" como superficie de
   * phishing. `@IsOptional()` deja pasar `null`/omitido sin correr `@Matches`.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\/uploads\//)
  fileUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
