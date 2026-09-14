import { ControlUnit, EquipmentClass, EquipmentStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const normalizeCode = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/**
 * Edición de la ficha del equipo (ADMIN). `internalCode` NO es editable a
 * propósito: es la clave de negocio con la que terreno, mantenimiento e
 * inventario referencian la máquina; renombrarla rompería la trazabilidad de
 * registros ya cargados. Si un equipo se dio de alta con el código
 * equivocado, se da de baja y se crea de nuevo.
 */
export class UpdateEquipmentDto {
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
}

/**
 * Body de `PATCH /api/equipment/:id/status`. Endpoint aparte del PATCH
 * general porque tiene otros permisos: el SUPERVISOR actualiza el estado de
 * la flota desde terreno (requerimientos §5.2, "Control de Flota") pero no
 * edita la ficha técnica.
 */
export class UpdateEquipmentStatusDto {
  @IsEnum(EquipmentStatus)
  status!: EquipmentStatus;
}
