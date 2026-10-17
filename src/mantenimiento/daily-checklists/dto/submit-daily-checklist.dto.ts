import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ChecklistEntryStatus } from '@prisma/client';

import { IsDateOnly } from '../../../shifts/date-only';
import { CreateIntervencionInsumoDto } from '../../dto/create-intervencion-insumo.dto';

/** Lo declarado de un ítem del catálogo. */
export class DailyChecklistEntryDto {
  @IsString()
  itemId!: string;

  @IsEnum(ChecklistEntryStatus)
  status!: ChecklistEntryStatus;

  /** Qué se hizo: obligatoria si `MAINTAINED` (la exige el servicio). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** Nota opcional al revisar. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** Temperatura medida en °C (A/C): obligatoria si el ítem la pide. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-40)
  @Max(80)
  temperature?: number;

  /**
   * Keys tmp de las fotos (`POST /api/files`, kind `checklist-photo`). Las
   * pone la cola sin conexión al subir cada archivo. Al corregir un checklist
   * rechazado también puede venir el `id` de una foto que ya tenía ese ítem
   * (`photos[].id` del detalle): esa se conserva.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  photoKeys?: string[];

  /** Insumos usados (solo con `MAINTAINED`): se descuentan del stock. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreateIntervencionInsumoDto)
  supplies?: CreateIntervencionInsumoDto[];
}

/**
 * El checklist diario completo de un equipo, tal como se envía al supervisor.
 * Se manda entero una sola vez: el borrador vive en el equipo del mantenedor.
 */
export class SubmitDailyChecklistDto {
  /** UUID v4 del cliente: clave de idempotencia para el reenvío sin señal. */
  @IsOptional()
  @IsUUID('4')
  id?: string;

  @IsString()
  equipmentId!: string;

  /** Día del checklist (`YYYY-MM-DD`, hora de Chile). */
  @IsDateOnly()
  date!: string;

  /**
   * Horómetro u odómetro al hacer el checklist. Obligatorio; queda solo en el
   * checklist y no actualiza la lectura del equipo.
   */
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'Anota el horómetro u odómetro del equipo.' },
  )
  counter!: number;

  /** Bodega de los insumos (la de faena). Obligatoria si se usaron. */
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DailyChecklistEntryDto)
  entries!: DailyChecklistEntryDto[];
}
