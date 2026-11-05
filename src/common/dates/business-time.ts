/**
 * Huso horario de negocio del sistema (Chile continental, UTC-3/UTC-4 según
 * horario de verano). Constante nombrada porque más de un punto necesita "el
 * día de calendario en Chile" a partir de un instante UTC: la ventana de
 * `shiftDate`, las etiquetas de avisos y los PDF.
 */
export const BUSINESS_TIME_ZONE = 'America/Santiago';

/**
 * `YYYY-MM-DD` del día de calendario en `BUSINESS_TIME_ZONE` para el instante
 * `date`, nunca el calendario UTC del proceso que corre el servidor: entre
 * ~20:00 y medianoche hora de Santiago el día UTC ya es el siguiente.
 * `Intl.DateTimeFormat` con locale `en-CA` da directamente el shape ISO
 * `YYYY-MM-DD` con year/month/day de 2 dígitos, sin reparsear otro formato.
 */
export function todayInBusinessTimeZone(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * `DD-MM-YYYY` del instante `date` en el calendario de `BUSINESS_TIME_ZONE`,
 * para textos que lee una persona (avisos, etiquetas). Sin el huso explícito,
 * un servidor en UTC muestra el día siguiente para lo registrado de noche.
 */
export function formatBusinessDate(date: Date): string {
  return date.toLocaleDateString('es-CL', { timeZone: BUSINESS_TIME_ZONE });
}

/**
 * `DD-MM-YYYY, HH:mm` del instante `date` en `BUSINESS_TIME_ZONE`, para
 * instantes reales que lee una persona (cierres, generación de un PDF). No
 * aplica a fechas de calendario sin hora, como la del turno.
 */
export function formatBusinessDateTime(date: Date): string {
  return new Intl.DateTimeFormat('es-CL', {
    timeZone: BUSINESS_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Clave `YYYY-MM-DD` del día de negocio al que pertenece un instante (zona
 * `BUSINESS_TIME_ZONE`, no la del servidor). Mismo cálculo que
 * `todayInBusinessTimeZone`; nombre propio para el uso de agrupación por día
 * del dashboard.
 */
export function businessDayKey(fecha: Date): string {
  return todayInBusinessTimeZone(fecha);
}

/**
 * Instante DENTRO del día de calendario chileno `dateOnly` (`YYYY-MM-DD`),
 * para fechar registros cargados a posteriori (días pasados): el dashboard y
 * las fichas agrupan por `businessDayKey(fecha)`, así que lo que importa es
 * que el instante caiga en ese día, no la hora exacta. Con el offset fijo −3,
 * en invierno chileno (UTC-4) el instante queda una hora antes en el reloj
 * local (11:00 / 19:30) pero siempre dentro del mismo día.
 */
export function businessDayInstant(
  dateOnly: string,
  time: '12:00' | '20:30' = '12:00',
): Date {
  return new Date(`${dateOnly}T${time}:00-03:00`);
}

/**
 * Hora (0–23) del reloj chileno para el instante `now`. `hourCycle: 'h23'`
 * evita el "24" de medianoche que da `hour12: false` en algunos ICU.
 */
export function businessHour(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: BUSINESS_TIME_ZONE,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  );
}

/**
 * ¿`dateOnly` es estrictamente anterior al día de calendario chileno de
 * `now`? Comparación de strings ISO (`YYYY-MM-DD` ordena igual que la fecha).
 * Criterio de DÍA pasado — para el criterio de TURNO pasado (que exceptúa al
 * nocturno de anoche todavía corriendo) ver `shifts/date-only.ts#isPastShift`.
 */
export function isPastBusinessDay(
  dateOnly: string,
  now: Date = new Date(),
): boolean {
  return dateOnly < todayInBusinessTimeZone(now);
}
