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

export class CreateEquipmentDocumentDto {
  @IsEnum(EquipmentDocumentType)
  type!: EquipmentDocumentType;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  /** Vencimiento del documento, ISO 8601. Ausente = sin dato (`SIN_DATO`). */
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  /**
   * Key `tmp/<userId>/<uuid>.<ext>` de un archivo recién subido por
   * `POST /api/files` (ver Diseño del RFC R2-storage, "Contrato de la API").
   * El DTO valida solo la FORMA (regex + largo) — `EquipmentDocumentService`
   * valida en capas que el segmento userId sea `session.user.id` y que la
   * extensión sea válida para "equipment-document" (imagen o PDF) vía
   * `StorageService.claimTmp`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(TMP_KEY_REGEX)
  fileKey?: string;

  /**
   * Nombre "humano" del archivo (el que subió el usuario, ej. "Póliza
   * Seguro.pdf") — se usa para el `Content-Disposition` al servir el
   * archivo, porque `fileKey` es un uuid sin significado.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
