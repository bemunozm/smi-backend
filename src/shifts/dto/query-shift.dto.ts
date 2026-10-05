import { IsIn } from 'class-validator';

import { IsDateOnly } from '../date-only';
import { SHIFT_TYPES, type ShiftType } from '../shift-type';

/** Query de `GET /api/shifts?date=YYYY-MM-DD&type=DIURNO|NOCTURNO` — el
 * contrato compartido con el Módulo B ("lista viva"). */
export class QueryShiftDto {
  /** Valida fecha real (no solo la forma): rechaza `2026-02-31` (rodaría a
   * marzo en silencio) y `2026-13-45` (daría 500 al serializar `Invalid
   * Date`). Sin ventana de fechas a propósito: es un
   * filtro de LECTURA, no crea `Shift` — no tiene el mismo riesgo. */
  @IsDateOnly()
  date!: string;

  @IsIn(SHIFT_TYPES)
  type!: ShiftType;
}
