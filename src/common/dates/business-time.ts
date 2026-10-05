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
