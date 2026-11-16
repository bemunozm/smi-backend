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

const normalizeCode = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/**
 * Edición de la ficha del equipo (ADMIN).
 */
export class UpdateEquipmentDto {
  /**
   * Código interno — editable desde el 16/11/2026 (el cliente renombra
   * equipos con nombres comunes para reconocerlos). Casi todo referencia al
   * equipo por `id`; las referencias por CÓDIGO (`OrdenTrabajo.equipoId`,
   * `Actividad.equipoId`) las actualiza `EquipmentService.update` en la
   * misma transacción.
   */
  @IsOptional()
  @Transform(normalizeCode)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  internalCode?: string;

  /**
   * Nullable a propósito: el frontend envía `null` explícito cuando el
   * usuario borra la patente en la edición (si se omitiera la propiedad,
   * la columna nunca se limpiaría). `@IsOptional()` deja pasar `null` sin
   * correr el resto de los validadores — confirmado empíricamente contra
   * class-validator 0.15.1 — así que solo hace falta ensanchar el tipo.
   */
  @IsOptional()
  @Transform(normalizeCode)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  licensePlate?: string | null;

  @IsOptional()
  @IsEnum(EquipmentClass)
  equipmentClass?: EquipmentClass;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  type?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  brand?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  model?: string;

  /**
   * Nullable a propósito (ver comentario de `licensePlate`). `@Type(() =>
   * Number)` de class-transformer 0.5.1 es null-safe: devuelve `null` tal
   * cual en vez de mangearlo a `Number(null) === 0` — confirmado
   * empíricamente, no hace falta un `@Transform` adicional.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1950)
  @Max(2100)
  year?: number | null;

  @IsOptional()
  @IsEnum(ControlUnit)
  controlUnit?: ControlUnit;

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

  /** Nullable a propósito (ver comentario de `licensePlate`). */
  @IsOptional()
  @IsString()
  homeBranchId?: string | null;

  /**
   * Tri-state:
   * `undefined` (propiedad omitida) deja la foto intacta, `null` explícito la
   * borra, un string es la key `tmp/<userId>/<uuid>.<ext>` de una foto nueva
   * subida por `POST /api/files` — el DTO valida solo la FORMA, igual que en
   * `CreateEquipmentDto.photoKey`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(TMP_KEY_REGEX)
  photoKey?: string | null;
}

/**
 * Body de `PATCH /api/equipment/:id/status`. Endpoint aparte del PATCH
 * general porque tiene otros permisos: el SUPERVISOR actualiza el estado de
 * la flota desde terreno pero no
 * edita la ficha técnica.
 */
export class UpdateEquipmentStatusDto {
  @IsEnum(EquipmentStatus)
  status!: EquipmentStatus;
}

/**
 * Body de `PATCH /api/equipment/:id/assignment`. Asigna/libera la asignación
 * de uso ACTUAL de la unidad (operador + supervisor a cargo ahora mismo).
 * Ambos campos son independientes: omitir la propiedad deja esa asignación
 * intacta; `null` explícito la libera (mismo criterio `@IsOptional()` +
 * ensanchar el tipo que el resto del DTO — ver comentario de `licensePlate`).
 * El `EquipmentService` valida `operatorId` contra el catálogo propio
 * (`OperatorsService.assertActive` — activo, existe) y `supervisorId` contra
 * `user` (rol SUPERVISOR, no baneado) antes de guardar — el operador no
 * es un usuario de la plataforma.
 */
export class UpdateEquipmentAssignmentDto {
  @IsOptional()
  @IsString()
  operatorId?: string | null;

  @IsOptional()
  @IsString()
  supervisorId?: string | null;
}
