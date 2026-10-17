import { ConflictException } from '@nestjs/common';
import { ChecklistStatus, type Prisma } from '@prisma/client';

import { ERROR_CODES } from '../../common/errors/error-codes';

/** Lo mínimo de Prisma que necesita la consulta (cliente o transacción). */
type Lector = Pick<Prisma.TransactionClient, 'dailyChecklist'>;

/**
 * Módulo 3 · R25: «el equipo no se libera para el operador hasta que el
 * supervisor acepte». Si ese día se envió el checklist del equipo y sigue por
 * validar o quedó rechazado, no se abre turno con él. Un equipo sin checklist
 * ese día queda libre (decisión de Joaquín, 16/10): el checklist se hace en la
 * colación y el bloqueo cubre el rato hasta que el supervisor lo acepta.
 *
 * Lo llaman los dos caminos que abren un turno: `ShiftsService.openCard`
 * (Registro de equipo) y `HorometroService.createFresh` (Flota).
 */
export async function assertChecklistNotPending(
  db: Lector,
  equipmentId: string,
  /** Día de calendario (medianoche UTC, como `@db.Date`). */
  date: Date,
): Promise<void> {
  const checklist = await db.dailyChecklist.findUnique({
    where: { equipmentId_date: { equipmentId, date } },
    select: { status: true },
  });
  if (!checklist || checklist.status === ChecklistStatus.ACCEPTED) return;
  throw new ConflictException({
    message:
      checklist.status === ChecklistStatus.REJECTED
        ? 'El checklist de hoy de este equipo fue rechazado: el mantenedor tiene que corregirlo y el supervisor aceptarlo antes de abrir turno.'
        : 'El checklist de hoy de este equipo está por validar: acéptalo en Terreno › Checklists antes de abrir turno.',
    code: ERROR_CODES.CHECKLIST_NOT_ACCEPTED,
  });
}
