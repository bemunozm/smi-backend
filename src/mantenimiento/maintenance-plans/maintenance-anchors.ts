/**
 * El «ancla» de cada equipo: su último cambio real, desde el que se cuenta la
 * próxima mantención (ver `computeMaintenanceStatus`).
 *
 * Se lee en una sola consulta para todos los equipos pedidos —la tabla de
 * Equipos, el pronóstico y la revisión periódica la piden de muchos a la vez—
 * y acepta el `tx` de una transacción: el cierre de una OT escribe el ancla y
 * la vuelve a leer dentro de la misma.
 */
import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../common/prisma/prisma.service';
import type { MaintenanceAnchor } from './maintenance-plan-status';

type Db = Prisma.TransactionClient | PrismaService;

/** El registro que marca el servicio de un liviano sin pauta (no es de ninguna operación). */
export const LIGHT_SERVICE_RECORD_KIND = 'SERVICIO';

/**
 * El último cambio de la pauta de cada equipo: el registro de una operación
 * con contador, el de mayor contador y, entre iguales, el más reciente. Los
 * registros sin contador no sirven: no dicen desde dónde contar.
 */
export function loadPlanAnchors(
  db: Db,
  equipmentIds: string[],
): Promise<Map<string, MaintenanceAnchor>> {
  return ultimos(db, equipmentIds, { planItemId: { not: null } });
}

/**
 * El último servicio de cada liviano sin pauta: no tiene operación de pauta
 * (`planItemId` nulo) y se guarda con `kind = 'SERVICIO'`.
 */
export function loadLightAnchors(
  db: Db,
  equipmentIds: string[],
): Promise<Map<string, MaintenanceAnchor>> {
  return ultimos(db, equipmentIds, {
    planItemId: null,
    kind: LIGHT_SERVICE_RECORD_KIND,
  });
}

async function ultimos(
  db: Db,
  equipmentIds: string[],
  filtro: Prisma.MaintenanceRecordWhereInput,
): Promise<Map<string, MaintenanceAnchor>> {
  const anclas = new Map<string, MaintenanceAnchor>();
  if (equipmentIds.length === 0) return anclas;
  const registros = await db.maintenanceRecord.findMany({
    where: {
      equipmentId: { in: [...new Set(equipmentIds)] },
      ...filtro,
      counterAt: { not: null },
    },
    orderBy: [{ counterAt: 'desc' }, { doneAt: 'desc' }],
    select: {
      equipmentId: true,
      milestone: true,
      cycle: true,
      counterAt: true,
      doneAt: true,
    },
  });
  // Vienen del más nuevo al más viejo: el primero de cada equipo es su ancla.
  // Un hito tiene una fila por operación, cada una con el contador de cuando
  // se marcó: manda la última.
  for (const r of registros) {
    if (anclas.has(r.equipmentId) || r.counterAt == null) continue;
    anclas.set(r.equipmentId, {
      milestone: r.milestone,
      cycle: r.cycle,
      counterAt: r.counterAt,
      doneAt: r.doneAt,
    });
  }
  return anclas;
}
