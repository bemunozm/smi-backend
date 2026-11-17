import { IsNumber, Max, Min } from 'class-validator';

import { IsDateOnly } from '../../../shifts/date-only';

/**
 * `PATCH /maintenance-plans/:equipmentId/last-change` — el administrador
 * corrige desde la pizarra la fecha y la lectura del último cambio (un error
 * de tipeo). El hito y la vuelta no cambian: solo cuándo y con qué contador.
 */
export class CorrectLastChangeDto {
  /** `YYYY-MM-DD` del cambio. El servicio exige que no sea futura. */
  @IsDateOnly()
  doneAt!: string;

  /** Horómetro o kilometraje del equipo al hacerlo (mismos topes que la
   * lectura de una mantención anterior). */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  counterAt!: number;
}
