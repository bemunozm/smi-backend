import { IsInt, Max, Min } from 'class-validator';

/**
 * «Asignar mantenciones» de un liviano: la mantención es siempre cada 10.000
 * km; se configura con cuánto avisar antes de ella y de cada papel.
 */
export class SaveLightConfigDto {
  /** Km antes de los 10.000 en que se avisa y se crea la orden (0 a 9.999). */
  @IsInt({ message: 'Los km de aviso tienen que ser un número entero.' })
  @Min(0, { message: 'Los km de aviso no pueden ser negativos.' })
  @Max(9_999, { message: 'El aviso tiene que ser menor que los 10.000 km.' })
  serviceAlertKm!: number;

  @IsInt({ message: 'Los días de aviso tienen que ser un número entero.' })
  @Min(1, { message: 'Avisa al menos 1 día antes.' })
  @Max(365, { message: 'El aviso puede ser hasta 365 días antes.' })
  technicalInspectionAlertDays!: number;

  @IsInt({ message: 'Los días de aviso tienen que ser un número entero.' })
  @Min(1, { message: 'Avisa al menos 1 día antes.' })
  @Max(365, { message: 'El aviso puede ser hasta 365 días antes.' })
  circulationPermitAlertDays!: number;

  @IsInt({ message: 'Los días de aviso tienen que ser un número entero.' })
  @Min(1, { message: 'Avisa al menos 1 día antes.' })
  @Max(365, { message: 'El aviso puede ser hasta 365 días antes.' })
  insuranceAlertDays!: number;
}
