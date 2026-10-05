import { Transform } from 'class-transformer';
import {
  IsBoolean,
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

/** Los campos que un `null` explícito no puede tocar: solo `undefined` los omite. */
const isPresent = (_: unknown, value: unknown): boolean => value !== undefined;

/**
 * Edición de una tarjeta de turno ya enviada (Acta N.° 004, R13). Se manda
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

  @ValidateIf(isPresent)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  valorInicial?: number;

  @ValidateIf(isPresent)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  valorFinal?: number;

  @ValidateIf(isPresent)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10_000)
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
