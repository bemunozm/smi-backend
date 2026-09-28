import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsDateString,
  IsIn,
  IsUUID,
} from 'class-validator';

import { IsDateOnly } from '../date-only';

export class CreateShiftReportDto {
  /** UUID v4 generado por el CLIENTE — idempotencia (RFC Supervisión en
   * Terreno §Reporte), mismo patrón que `OpenShiftCardDto.id`. */
  @IsUUID('4')
  id!: string;

  /** `YYYY-MM-DD`, sin hora — ver `date-only.ts`. Ver el mismo comentario en
   * `OpenShiftCardDto.shiftDate` sobre por qué la ventana de fechas (B2(b))
   * se valida aparte, en `ShiftReportsService.create`. */
  @IsDateOnly()
  shiftDate!: string;

  @IsIn(['DIURNO', 'NOCTURNO'])
  shiftType!: string;

  /** Ids de tarjeta (`RegistroHorometro.id`) a incluir en el PDF. 1..100,
   * sin duplicados — algunos pueden no existir todavía en el servidor (una
   * apertura puede seguir encolada en el outbox offline del dispositivo):
   * ver `ShiftReportsService.create`, que genera el PDF con las que SÍ
   * encuentra y devuelve el resto en `missingCardIds`. */
  @IsUUID('4', { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  cardIds!: string[];

  /** Hora del DISPOSITIVO al pedir el reporte — ver `capture-time.ts`. */
  @IsDateString()
  requestedAt!: string;
}
