import {
  IsDateString,
  IsIn,
  IsNumber,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { IsDateOnly } from '../date-only';
import { SHIFT_TYPES, type ShiftType } from '../shift-type';

export class OpenShiftCardDto {
  /** UUID v4 generado por el CLIENTE — es el PK de `RegistroHorometro` (RFC
   * Supervisión en Terreno §Diseño): permite que "abrir tarjeta" sea
   * idempotente sin ida y vuelta al servidor antes de poder escribir (clave
   * para el flujo offline). */
  @IsUUID('4')
  id!: string;

  @IsString()
  equipoId!: string;

  /** Operador del catálogo propio (`Operator`) — a diferencia de Flota, ACÁ
   * es obligatorio: la tarjeta de turno siempre tiene un operador asignado.
   * `ShiftsService` valida que exista y esté activo (404 / 409
   * `OPERATOR_INACTIVE`). */
  @IsString()
  operatorId!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  valorInicial!: number;

  /** `YYYY-MM-DD`, sin hora — ver `date-only.ts`. Valida shape + calendario
   * real; la ventana de fechas razonable se valida aparte en
   * `ShiftsService.openCard` (necesita `code: 'INVALID_SHIFT_DATE'`, que un
   * decorador de class-validator no puede devolver). */
  @IsDateOnly()
  shiftDate!: string;

  @IsIn(SHIFT_TYPES)
  shiftType!: ShiftType;

  /** Hora del DISPOSITIVO al abrir la tarjeta (no la del servidor) — ver
   * `capture-time.ts`. */
  @IsDateString()
  capturedAt!: string;
}
