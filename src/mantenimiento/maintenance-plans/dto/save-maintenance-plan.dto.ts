import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Qué es cada fila de la pauta. Agrupa la tabla como en las planillas. */
export const PLAN_ITEM_KINDS = [
  'FILTRO',
  'ACEITE',
  'CORREA',
  'OPERACION',
] as const;

/** Tope de un contador: el mismo que usa Terreno para horómetros. */
const MAX_CONTADOR = 1_000_000;

export class MaintenancePlanItemDto {
  @IsIn(PLAN_ITEM_KINDS)
  kind!: string;

  @IsString()
  @MinLength(1, { message: 'Cada operación necesita una descripción' })
  @MaxLength(200)
  description!: string;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  quantity?: number;

  /** «LT», «KG», «UN»… texto corto, como en la planilla. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  partNumber?: string;

  @IsOptional()
  @IsString()
  inventoryItemId?: string;

  /** Hitos en que se hace esta operación (marcas de la fila). */
  @IsArray()
  @ArrayMaxSize(60)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_CONTADOR, { each: true })
  milestones!: number[];
}

/**
 * La pauta completa de un equipo. Se guarda entera —hitos, filas y marcas—
 * porque así se edita: como una planilla, no fila por fila. Las reglas que
 * cruzan campos (marcas solo en hitos que existen, servicio inicial antes del
 * primer hito) las valida el servicio.
 */
export class SaveMaintenancePlanDto {
  @IsArray()
  @ArrayMaxSize(60)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_CONTADOR, { each: true })
  milestones!: number[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_CONTADOR)
  initialMilestone?: number | null;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => MaintenancePlanItemDto)
  items!: MaintenancePlanItemDto[];
}
