/**
 * `ShiftExitReport.emailStatus` — la columna Prisma sigue siendo `String`
 * (mismo vocabulario libre que el resto del schema de Terreno), así que este
 * union es la única fuente de verdad para los 4 valores que el código
 * escribe/lee, en vez de repetirlos en cada archivo que los usa
 * (`ShiftReportsService`, `NotificationsListener`, el shape de respuesta).
 */
export const SHIFT_EXIT_REPORT_EMAIL_STATUSES = [
  'PENDING',
  'SENT',
  'FAILED',
  'SKIPPED',
] as const;

export type ShiftExitReportEmailStatus =
  (typeof SHIFT_EXIT_REPORT_EMAIL_STATUSES)[number];

/** Estado inicial de toda fila nueva (`ShiftReportsService.create`) — nombrado
 * aparte para que `markEmailStatus` pueda usarlo como guarda de transición sin
 * un literal mágico repetido. */
export const SHIFT_EXIT_REPORT_EMAIL_STATUS_INITIAL: ShiftExitReportEmailStatus =
  'PENDING';
