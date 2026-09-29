/**
 * Turno DIURNO/NOCTURNO — compartido por `Shift.type`, `RegistroHorometro.turno`
 * y `TrabajoExtraordinario.turno` (mismo vocabulario en los tres dominios que
 * lo usan: Supervisión en Terreno, Flota y Trabajos extra). Única fuente de
 * verdad para los `@IsIn()` de sus 5 DTOs, en vez de repetir el array literal
 * en cada uno.
 */
export const SHIFT_TYPES = ['DIURNO', 'NOCTURNO'] as const;

export type ShiftType = (typeof SHIFT_TYPES)[number];
