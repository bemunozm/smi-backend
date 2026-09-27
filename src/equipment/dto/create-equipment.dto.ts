import { ControlUnit, EquipmentClass, EquipmentStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { TMP_KEY_REGEX } from '../../storage/storage-keys';

/**
 * Normaliza el código interno: es la clave de negocio (patente / ID interno)
 * y además es `@unique`. Sin esto, "ex-001" y "EX-001" entran como dos
 * equipos distintos y el operador en terreno termina cargando horómetro en la
 * máquina equivocada.
 */
const normalizeCode = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateEquipmentDto {
  @Transform(normalizeCode)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  internalCode!: string;

  /** Patente. Nullable: equipos pesados suelen no tenerla. */
  @IsOptional()
  @Transform(normalizeCode)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  licensePlate?: string;

  @IsEnum(EquipmentClass)
  equipmentClass!: EquipmentClass;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  type!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  brand!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  model!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1950)
  @Max(2100)
  year?: number;

  @IsEnum(ControlUnit)
  controlUnit!: ControlUnit;

  @IsOptional()
  @IsEnum(EquipmentStatus)
  status?: EquipmentStatus;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  currentHourmeter?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  currentMileage?: number;

  /** Sucursal base de la unidad (opcional). */
  @IsOptional()
  @IsString()
  homeBranchId?: string;

  /**
   * Key `tmp/<userId>/<uuid>.<ext>` de una foto recién subida por
   * `POST /api/files` (ver Diseño del RFC R2-storage, "Contrato de la API").
   * El DTO valida solo la FORMA (regex + largo) — `EquipmentService` valida
   * en capas que el segmento userId sea `session.user.id` y que la
   * extensión sea válida para "equipment-photo" (`StorageService.claimTmp`
   * vía `assertOwnedTmpKey`).
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(TMP_KEY_REGEX)
  photoKey?: string;
}
