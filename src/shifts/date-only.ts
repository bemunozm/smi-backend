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

import {
  businessDayInstant,
  businessHour,
  isPastBusinessDay,
  todayInBusinessTimeZone,
} from '../common/dates/business-time';
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
 * ¿El par (shiftDate, shiftType) es un turno YA TERMINADO de un día de
 * negocio pasado — es decir, carga histórica y no flujo vivo?
 *
 * La trampa es el NOCTURNO: corre de 20:00 a 08:00 del día siguiente, y
 * antes de las 08:00 el frontend vivo manda el `shiftDate` de AYER
 * (`fechaDeTurno`). Ese turno tiene día de negocio pasado pero sigue
 * corriendo: tratarlo como backfill saltaría el guard de equipo no
 * operativo y fecharía sintético un registro vivo. El espejo frontend es
 * `lib/turno.ts#esTurnoPasado`.
 */
export function isPastShift(
  shiftDate: string,
  shiftType: string,
  now: Date = new Date(),
): boolean {
  if (!isPastBusinessDay(shiftDate, now)) return false;
  if (shiftType !== 'NOCTURNO') return true;
  const ayer = parseDateOnlyUtc(todayInBusinessTimeZone(now));
  ayer.setUTCDate(ayer.getUTCDate() - 1);
  const esNocturnoDeAnoche = shiftDate === formatDateOnly(ayer);
  // Hasta las 08:00 en Chile, el nocturno de anoche sigue vivo.
  return !(esNocturnoDeAnoche && businessHour(now) < SHIFT_DAY_START_HOUR);
}

/** Hora chilena a la que cambia el día de turno: el DIURNO abre a las 08:00 y
 * el NOCTURNO (20:00–08:00) pertenece al día en que ABRE. Antes de las 08:00
 * el día de turno es el ANTERIOR — espejo del frontend
 * `lib/turno.ts#fechaDeTurno`. */
export const SHIFT_DAY_START_HOUR = 8;

/** Hora chilena en que termina el DIURNO (y empieza el NOCTURNO). */
export const DIURNO_END_HOUR = 20;

/**
 * ¿Ya terminó el turno (`shiftDate`, `shiftType`) en el reloj chileno de
 * `now`? El DIURNO termina a las 20:00 de su día; el NOCTURNO, a las 08:00
 * del día SIGUIENTE. Compara día y hora de Chile por separado, así no
 * depende del horario de verano.
 */
export function hasShiftEnded(
  shiftDate: string,
  shiftType: string,
  now: Date = new Date(),
): boolean {
  const hoy = todayInBusinessTimeZone(now);
  const hora = businessHour(now);
  if (shiftType !== 'NOCTURNO') {
    return hoy > shiftDate || (hoy === shiftDate && hora >= DIURNO_END_HOUR);
  }
  const siguiente = parseDateOnlyUtc(shiftDate);
  siguiente.setUTCDate(siguiente.getUTCDate() + 1);
  const finDia = formatDateOnly(siguiente);
  return hoy > finDia || (hoy === finDia && hora >= SHIFT_DAY_START_HOUR);
}

/**
 * Día de turno (`YYYY-MM-DD`) que el RELOJ asigna al instante `at`: antes de
 * las 08:00 de Chile sigue corriendo el turno que abrió el día anterior.
 * Espejo del frontend `lib/turno.ts#fechaDeTurno`. Es el fallback para fechar
 * una tarjeta sin `Shift` vinculado; cuando el `Shift` existe, manda su
 * `date`.
 */
export function shiftDayOf(at: Date): string {
  const dia = parseDateOnlyUtc(todayInBusinessTimeZone(at));
  if (businessHour(at) < SHIFT_DAY_START_HOUR) {
    dia.setUTCDate(dia.getUTCDate() - 1);
  }
  return formatDateOnly(dia);
}

/**
 * Día de turno (`YYYY-MM-DD`) al que se ATRIBUYE una tarjeta en las vistas
 * por día (resumen del día, métricas de equipos/supervisores): manda el
 * `date` del `Shift` vinculado — el día REPORTADO por quien la abrió — y sin
 * turno vinculado decide el reloj de su hora de entrada (`shiftDayOf`).
 * Misma regla con que se fecha la carga de combustible del cierre
 * (`fuelDateForShiftDay`, pedido del cliente 13/14-11): la tarjeta nocturna
 * abierta de MADRUGADA pertenece al día ANTERIOR, no al día calendario de su
 * `fecha`. La `fecha` (hora real de entrada) no se toca: solo cambia el día
 * al que se atribuye.
 */
export function cardShiftDay(card: {
  fecha: Date;
  shift?: { date: Date } | null;
}): string {
  return card.shift ? formatDateOnly(card.shift.date) : shiftDayOf(card.fecha);
}

/**
 * Instante con que se fecha la carga de combustible de un cierre/edición de
 * tarjeta (pedido del cliente, 13-11: la carga pertenece al día del turno en
 * que queda reportada la tarjeta, aunque el cierre real caiga en otro día —
 * incluso pasadas las 08:00 del día siguiente). Si el instante real `at` cae
 * dentro del día chileno `shiftDay`, queda tal cual; si no, un instante
 * sintético DENTRO de ese día (20:30 −03 NOCTURNO, 12:00 −03 DIURNO — mismo
 * patrón que el backfill histórico). La hora real del registro sobrevive en
 * `createdAt`, que el panel ya muestra como «registrada el …».
 */
export function fuelDateForShiftDay(
  at: Date,
  shiftDay: string,
  shiftType: string,
): Date {
  if (todayInBusinessTimeZone(at) === shiftDay) return at;
  return businessDayInstant(
    shiftDay,
    shiftType === 'NOCTURNO' ? '20:30' : '12:00',
  );
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
