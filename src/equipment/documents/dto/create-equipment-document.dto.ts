import { EquipmentDocumentType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

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
   * URL del archivo adjunto (se sube por el `/api/uploads` existente). Solo
   * acepta rutas internas de uploads — nunca un dominio externo arbitrario,
   * que abriría el link "Ver/descargar" como superficie de phishing.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\/uploads\//)
  fileUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
