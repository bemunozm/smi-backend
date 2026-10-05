/**
 * `Shift.date` es `@db.Date`: un turno es "el día X", no un instante, así que
 * dos turnos del mismo día no pueden diferir por huso horario. La API SIEMPRE
 * trata esta columna como el string `YYYY-MM-DD` que el cliente manda/recibe,
 * nunca como una hora local.
 *
 * Regla dura: construir SIEMPRE a medianoche UTC (`T00:00:00.000Z`) y leer
 * SIEMPRE con los getters UTC — nunca `new Date(str)` a secas (ambiguo según
 * el TZ del proceso) ni `toISOString()` de una medianoche LOCAL (se corre de
 * día según el huso horario del server).
 */
import { BadRequestException } from '@nestjs/common';
import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

import { todayInBusinessTimeZone } from '../common/dates/business-time';
import { ERROR_CODES } from '../common/errors/error-codes';

export const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnlyString(value: string): boolean {
  return DATE_ONLY_REGEX.test(value);
}

export function parseDateOnlyUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function formatDateOnly(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * `true` solo si `value` tiene shape `YYYY-MM-DD` Y describe una fecha de
 * calendario real. El shape solo (`DATE_ONLY_REGEX`) no alcanza:
 * `new Date('2026-02-31T00:00:00.000Z')` no da `Invalid Date`, la desborda
 * silenciosamente a `2026-03-03`, y "2026-13-45" da `Invalid Date` pero
 * `.toISOString()` lanza `RangeError` recién cuando Prisma serializa el valor
 * (500 no controlado). El ida-y-vuelta
 * (`formatDateOnly(parseDateOnlyUtc(value)) === value`) atrapa los dos casos
 * con una sola comprobación.
 */
export function isValidDateOnly(value: string): boolean {
  if (!isDateOnlyString(value)) return false;
  const parsed = parseDateOnlyUtc(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return formatDateOnly(parsed) === value;
}

/**
 * Valida shape Y calendario real (`isValidDateOnly`) de todo `shiftDate`/`date`
 * de Supervisión en Terreno en un solo decorador.
 */
export function IsDateOnly(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isDateOnly',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isValidDateOnly(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} debe ser una fecha real en formato YYYY-MM-DD`;
        },
      },
    });
  };
}

/**
 * Ventana de `shiftDate`, en DÍAS de calendario (no ms de reloj) porque
 * `shiftDate` es date-only. 30 días de pasado: una tablet que pasó días sin
 * señal tiene que poder sincronizar sus tarjetas y pedir el reporte de un
 * turno atrasado. 1 día de futuro: turno nocturno que cruza medianoche,
 * abierto "para mañana" desde la noche anterior.
 */
export const SHIFT_DATE_MAX_PAST_DAYS = 30;
export const SHIFT_DATE_MAX_FUTURE_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 400 `INVALID_SHIFT_DATE` si `shiftDate` cae fuera de
 * `[hoy - 30 días, hoy + 1 día]`. Llamar SIEMPRE después de que `shiftDate` ya
 * pasó `@IsDateOnly()` (asume shape+calendario válidos). Lo usan
 * `ShiftsService.openCard` y `ShiftReportsService.create`, que escriben un
 * `Shift`; el query de lectura `GET /api/shifts` no lo necesita porque un
 * filtro no crea un `Shift` para una fecha arbitraria.
 */
export function assertShiftDateWithinWindow(
  shiftDate: string,
  now: Date = new Date(),
): void {
  const date = parseDateOnlyUtc(shiftDate);
  // "Hoy" es el día de calendario en Chile, no el día UTC del proceso: de lo
  // contrario la ventana se corre un día entre ~20:00 y medianoche en Santiago.
  const today = parseDateOnlyUtc(todayInBusinessTimeZone(now));
  const diffDays = Math.round((date.getTime() - today.getTime()) / MS_PER_DAY);

  if (
    diffDays < -SHIFT_DATE_MAX_PAST_DAYS ||
    diffDays > SHIFT_DATE_MAX_FUTURE_DAYS
  ) {
    throw new BadRequestException({
      message: `La fecha del turno (${shiftDate}) está fuera de rango (hasta ${SHIFT_DATE_MAX_PAST_DAYS} días de antigüedad o ${SHIFT_DATE_MAX_FUTURE_DAYS} día a futuro)`,
      code: ERROR_CODES.INVALID_SHIFT_DATE,
    });
  }
}
