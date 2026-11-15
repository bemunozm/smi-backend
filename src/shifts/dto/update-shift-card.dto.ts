import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { normalizeObservaciones } from '../../common/normalize-observaciones';
import { ADBLUE_MAX_LITERS } from '../adblue';
import { FUEL_LITERS_MAX, FUEL_LITERS_MAX_MESSAGE } from '../fuel';
import { SHIFT_TYPES } from '../shift-type';
import type { ShiftType } from '../shift-type';

/** Los campos que un `null` explícito no puede tocar: solo `undefined` los omite. */
const isPresent = (_: unknown, value: unknown): boolean => value !== undefined;

/**
 * Edición de una tarjeta de turno ya enviada. Se manda
 * solo lo que cambió; al menos un campo (lo verifica `ShiftsService.update`,
 * que ve el body completo). Mismos límites que al abrir y al cerrar.
 *
 * La consistencia entre `adBlue` y `adBlueLiters` se valida en el servicio
 * sobre el estado ya mezclado: un body con solo los litros depende de si la
 * tarjeta ya tenía AdBlue.
 */
export class UpdateShiftCardDto {
  @ValidateIf(isPresent)
  @IsString()
  operatorId?: string;

  /** Corrige en qué turno salió el equipo (solo tarjeta ya cerrada): la
   * tarjeta se mueve al turno del MISMO día y supervisor con el otro tipo. */
  @ValidateIf(isPresent)
  @IsIn(SHIFT_TYPES, { message: 'El turno debe ser DIURNO o NOCTURNO.' })
  turno?: ShiftType;

  /** Corrige qué máquina salió (solo tarjeta ya cerrada); debe ser de la
   * misma clase (pesado/liviano) que la original. */
  @ValidateIf(isPresent)
  @IsString()
  @IsNotEmpty({ message: 'Indica el equipo.' })
  equipoId?: string;

  @ValidateIf(isPresent)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0, { message: 'La lectura no puede ser negativa.' })
  @Max(1_000_000, { message: 'La lectura no puede superar 1.000.000.' })
  valorInicial?: number;

  @ValidateIf(isPresent)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0, { message: 'La lectura no puede ser negativa.' })
  @Max(1_000_000, { message: 'La lectura no puede superar 1.000.000.' })
  valorFinal?: number;

  @ValidateIf(isPresent)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0, { message: 'Los litros no pueden ser negativos.' })
  @Max(FUEL_LITERS_MAX, { message: FUEL_LITERS_MAX_MESSAGE })
  fuelLiters?: number;

  @ValidateIf(isPresent)
  @IsBoolean()
  adBlue?: boolean;

  /** `null` limpia los litros (al quitar el AdBlue). */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(ADBLUE_MAX_LITERS)
  adBlueLiters?: number | null;

  /** `null` (o vacío) borra las observaciones. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeObservaciones(value))
  @IsString()
  @MaxLength(1000)
  observaciones?: string | null;
}
