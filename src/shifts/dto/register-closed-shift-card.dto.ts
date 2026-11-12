import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { normalizeObservaciones } from '../../common/normalize-observaciones';
import { TMP_KEY_REGEX } from '../../storage/storage-keys';
import { IsAdBlueLitersConsistent } from '../adblue';
import { IsDateOnly } from '../date-only';
import { FUEL_LITERS_MAX, FUEL_LITERS_MAX_MESSAGE } from '../fuel';
import { SHIFT_TYPES, type ShiftType } from '../shift-type';

/**
 * Body de `POST /api/shift-cards/closed` — registro histórico de un turno YA
 * TERMINADO: la tarjeta nace cerrada (apertura + cierre en una transacción),
 * así el backfill nunca ocupa el "slot" de tarjeta abierta del equipo ni
 * choca con una tarjeta abierta HOY. Une los campos de `OpenShiftCardDto` y
 * `CloseShiftCardDto` (mismos validadores y límites).
 */
export class RegisterClosedShiftCardDto {
  /** UUID v4 del CLIENTE — PK de `RegistroHorometro`, clave de idempotencia
   * del registro completo (mismo criterio que la apertura). */
  @IsUUID('4')
  id!: string;

  @IsString()
  equipoId!: string;

  /** Operador del catálogo — obligatorio en pesados (lo exige el service). */
  @IsOptional()
  @IsString()
  operatorId?: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0, { message: 'La lectura no puede ser negativa.' })
  @Max(1_000_000, { message: 'La lectura no puede superar 1.000.000.' })
  valorInicial!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0, { message: 'La lectura no puede ser negativa.' })
  @Max(1_000_000, { message: 'La lectura no puede superar 1.000.000.' })
  valorFinal!: number;

  /** Día de negocio del turno histórico (`YYYY-MM-DD`). El service exige
   * `isPastShift(shiftDate, shiftType)` — un turno vivo se registra por
   * abrir/cerrar, nunca por acá. */
  @IsDateOnly()
  shiftDate!: string;

  @IsIn(SHIFT_TYPES)
  shiftType!: ShiftType;

  /** Hora del DISPOSITIVO al registrar (auditoría de desfase; la tarjeta
   * igual se fecha DENTRO del día histórico). */
  @IsDateString()
  capturedAt!: string;

  /** UUID v4 de ESTE intento — espejo de `CloseShiftCardDto.closeClientId`
   * (`@unique` en `RegistroHorometro`). */
  @IsUUID('4')
  closeClientId!: string;

  @IsNumber()
  @Min(0, { message: 'Los litros no pueden ser negativos.' })
  @Max(FUEL_LITERS_MAX, { message: FUEL_LITERS_MAX_MESSAGE })
  fuelLiters!: number;

  @IsOptional()
  @IsBoolean()
  adBlue?: boolean;

  @IsAdBlueLitersConsistent()
  adBlueLiters?: number | null;

  /** Foto del surtidor/horómetro — obligatoria AUN con 0 litros, igual que
   * en el cierre normal. */
  @IsString()
  @MaxLength(160)
  @Matches(TMP_KEY_REGEX)
  tmpPhotoKey!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeObservaciones(value))
  @IsString()
  @MaxLength(1000)
  observaciones?: string;
}
