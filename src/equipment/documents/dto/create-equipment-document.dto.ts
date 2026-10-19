import { EquipmentDocumentType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { TMP_KEY_REGEX } from '../../../storage/storage-keys';

export class CreateEquipmentDocumentDto {
  /** UUID v4 generado por el cliente: clave de idempotencia para el reenvío
   * offline. Opcional para no romper a un cliente que no lo manda. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

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
   * `POST /api/files`.
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

  /**
   * Módulo 4: con cuántos días de anticipación avisar que vence (1 a 365).
   * Sin dato, el documento usa 30.
   */
  @IsOptional()
  @IsInt({ message: 'Los días de aviso tienen que ser un número entero.' })
  @Min(1, { message: 'Avisa al menos 1 día antes.' })
  @Max(365, { message: 'El aviso puede ser hasta 365 días antes.' })
  alertDaysBefore?: number;
}
