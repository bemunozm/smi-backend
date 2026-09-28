/**
 * `Shift.date` es `@db.Date` (RFC Supervisión en Terreno §Diseño): un turno
 * es "el día X", no un instante — así que dos turnos del mismo día no pueden
 * diferir por huso horario. La API SIEMPRE trata esta columna como el string
 * `YYYY-MM-DD` que el cliente manda/recibe, nunca como una hora local.
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

export const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Huso horario de negocio del sistema (Chile continental, UTC-3/UTC-4 según
 * horario de verano) — constante nombrada porque más de un punto necesita
 * "el día de calendario en Chile" a partir de un instante UTC: acá
 * (`todayInBusinessTimeZone`, para la ventana de `shiftDate`) y en
 * `pdf/shift-report.pdf.ts` (`formatSantiagoDateTime`, que la reusa en vez de
 * repetir el string). */
export const BUSINESS_TIME_ZONE = 'America/Santiago';

/**
 * `YYYY-MM-DD` del día de calendario en `BUSINESS_TIME_ZONE` para el instante
 * `date` — NUNCA el calendario UTC del proceso que corre el servidor. Bug que
 * corrige (auditoría de seguridad, 28/09): entre ~20:00 y medianoche hora de
 * Santiago, el día UTC ya es el siguiente — `assertShiftDateWithinWindow`
 * calculaba "hoy" con el calendario UTC (vía `formatDateOnly`, que lee con
 * getters UTC) y corría la ventana un día completo justo en esa franja.
 * `Intl.DateTimeFormat` con locale `en-CA` da directamente el shape ISO
 * `YYYY-MM-DD` para year/month/day en formato 2 dígitos — sin reparsear un
 * string con otro shape.
 */
export function todayInBusinessTimeZone(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

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
 * calendario real (B2(a) de la auditoría de seguridad). El shape solo
 * (`DATE_ONLY_REGEX`) NO alcanza: `new Date('2026-02-31T00:00:00.000Z')` no
 * da `Invalid Date`, la desborda silenciosamente a `2026-03-03` — así que
 * "2026-02-31" pasaba como shiftDate válido y corrompía la fecha guardada
 * sin que nadie lo notara. "2026-13-45" sí da `Invalid Date` (NaN), pero
 * `.toISOString()` sobre eso lanza `RangeError` recién cuando Prisma
 * serializa el valor — 500 no controlado. El ida-y-vuelta
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
 * Reemplaza `@Matches(DATE_ONLY_REGEX)` en todo `shiftDate`/`date` de
 * Supervisión en Terreno (B2(a)): valida shape Y calendario real
 * (`isValidDateOnly`) en un solo decorador.
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

/** Ventana de `shiftDate` (B2(b) de la auditoría de seguridad) — mismo
 * espíritu que `MAX_FUTURE_CAPTURE_SKEW_MS`/`MAX_PAST_CAPTURE_SKEW_MS` de
 * `capture-time.ts`, pero en DÍAS de calendario (no ms de reloj) porque
 * `shiftDate` es date-only. 8 días de pasado (un poco más que la ventana de
 * 7 días de `capturedAt`: un reporte puede pedirse un día después de que la
 * tarjeta se cerró offline) y 1 día de futuro (turno nocturno que cruza
 * medianoche, abierto "para mañana" desde la noche anterior). */
export const SHIFT_DATE_MAX_PAST_DAYS = 8;
export const SHIFT_DATE_MAX_FUTURE_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 400 `INVALID_SHIFT_DATE` si `shiftDate` cae fuera de
 * `[hoy - 8 días, hoy + 1 día]`. Llamar SIEMPRE después de que `shiftDate` ya
 * pasó `@IsDateOnly()` (asume shape+calendario válidos) — usado por
 * `ShiftsService.openCard`/`ShiftReportsService.create`, nunca por el query
 * de `GET /api/shifts` (un filtro de lectura no tiene el mismo riesgo de
 * crear un `Shift` para una fecha arbitraria).
 */
export function assertShiftDateWithinWindow(
  shiftDate: string,
  now: Date = new Date(),
): void {
  const date = parseDateOnlyUtc(shiftDate);
  // "Hoy" es el día de calendario en Chile, NO el día UTC del proceso (ver
  // comentario de `todayInBusinessTimeZone`) — de lo contrario la ventana se
  // corre un día completo entre ~20:00 y medianoche hora de Santiago.
  const today = parseDateOnlyUtc(todayInBusinessTimeZone(now));
  const diffDays = Math.round((date.getTime() - today.getTime()) / MS_PER_DAY);

  if (
    diffDays < -SHIFT_DATE_MAX_PAST_DAYS ||
    diffDays > SHIFT_DATE_MAX_FUTURE_DAYS
  ) {
    throw new BadRequestException({
      message: `La fecha del turno (${shiftDate}) está fuera de rango (hasta ${SHIFT_DATE_MAX_PAST_DAYS} días de antigüedad o ${SHIFT_DATE_MAX_FUTURE_DAYS} día a futuro)`,
      code: 'INVALID_SHIFT_DATE',
    });
  }
}
