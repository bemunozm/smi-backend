/**
 * El «ancla» de cada equipo: su último cambio real, desde el que se cuenta la
 * próxima mantención (ver `computeMaintenanceStatus`).
 *
 * Se lee en una sola consulta para todos los equipos pedidos —la tabla de
 * Equipos, el pronóstico y la revisión periódica la piden de muchos a la vez—
 * y acepta el `tx` de una transacción: el cierre de una OT escribe el ancla y
 * la vuelve a leer dentro de la misma.
 */
import { BadRequestException } from '@nestjs/common';
import { EstadoOT, type Prisma } from '@prisma/client';

import type { PrismaService } from '../../common/prisma/prisma.service';
import type { MaintenanceAnchor } from './maintenance-plan-status';

type Db = Prisma.TransactionClient | PrismaService;

/** El registro que marca el servicio de un liviano sin pauta (no es de ninguna operación). */
export const LIGHT_SERVICE_RECORD_KIND = 'SERVICIO';

/**
 * El último cambio de la pauta de cada equipo: el registro de una operación
 * con contador que va más adelante en la secuencia —la vuelta más alta y, en
 * ella, el hito más alto— y, entre las operaciones de un mismo hito, la de
 * mayor contador y la más reciente. No se ordena por contador: la grilla del
 * ciclo guarda el horómetro de hoy al marcar, y completar ahí una operación de
 * una vuelta pasada no puede volver atrás la próxima mantención. El servicio
 * inicial queda antes del primer hito de la vuelta 1 por ser menor (la pauta
 * no acepta uno que no lo sea). Los registros sin contador no sirven: no dicen
 * desde dónde contar.
 *
 * `excluir` deja fuera un hito y vuelta: al cerrar una orden de pauta, sus
 * propios registros (escritos al marcar cada tarea) no son «la anterior».
 */
export function loadPlanAnchors(
  db: Db,
  equipmentIds: string[],
  excluir?: { cycle: number; milestone: number },
): Promise<Map<string, MaintenanceAnchor>> {
  return ultimos(
    db,
    equipmentIds,
    {
      planItemId: { not: null },
      ...(excluir
        ? { NOT: { cycle: excluir.cycle, milestone: excluir.milestone } }
        : {}),
    },
    [{ cycle: 'desc' }, { milestone: 'desc' }, ...POR_CONTADOR],
  );
}

/**
 * El último servicio de cada liviano sin pauta: no tiene operación de pauta
 * (`planItemId` nulo) y se guarda con `kind = 'SERVICIO'`. Manda la vuelta más
 * alta y, en ella, el mayor contador.
 *
 * `excluir` deja fuera una vuelta (un número de servicio): al corregir el
 * último servicio, el suyo no es «el anterior».
 */
export function loadLightAnchors(
  db: Db,
  equipmentIds: string[],
  excluir?: { cycle: number },
): Promise<Map<string, MaintenanceAnchor>> {
  return ultimos(
    db,
    equipmentIds,
    {
      planItemId: null,
      kind: LIGHT_SERVICE_RECORD_KIND,
      ...(excluir ? { NOT: { cycle: excluir.cycle } } : {}),
    },
    [{ cycle: 'desc' }, ...POR_CONTADOR],
  );
}

const NUM_CL = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 });

/**
 * Cómo empieza el `origenDetalle` de una mantención anterior (registro
 * histórico, `OrdenesService.createHistorica`); las observaciones van detrás.
 */
export const HISTORICA_ORIGEN_DETALLE =
  'Mantención anterior (registro histórico)';

/** El `origenDetalle` de una mantención anterior, con sus observaciones. */
export function origenDetalleHistorica(
  observaciones: string | null | undefined,
): string {
  return observaciones
    ? `${HISTORICA_ORIGEN_DETALLE}: ${observaciones}`
    : HISTORICA_ORIGEN_DETALLE;
}

/** La orden es una mantención anterior (no una del taller). */
export function esMantencionHistorica(orden: {
  origen: string;
  origenDetalle: string | null;
}): boolean {
  return (
    orden.origen === 'MANUAL' &&
    (orden.origenDetalle?.startsWith(HISTORICA_ORIGEN_DETALLE) ?? false)
  );
}

/** Las observaciones de una mantención anterior (lo que va tras el prefijo). */
export function observacionesHistorica(
  origenDetalle: string | null,
): string | null {
  if (!origenDetalle?.startsWith(`${HISTORICA_ORIGEN_DETALLE}: `)) return null;
  return origenDetalle.slice(HISTORICA_ORIGEN_DETALLE.length + 2) || null;
}

/**
 * La nota de lectura de la tarea de una mantención anterior, con la unidad
 * del equipo: kilometraje (`controlUnit` KM) u horómetro.
 */
export function notaLecturaHistorica(
  lectura: number,
  controlUnit: string,
): string {
  return controlUnit === 'KM'
    ? `Kilometraje al momento de la mantención: ${NUM_CL.format(lectura)} km`
    : `Horómetro al momento de la mantención: ${NUM_CL.format(lectura)} h`;
}

/**
 * La lectura de una mantención no puede pasar la lectura actual del equipo.
 * La comparten el cierre de una orden, la mantención anterior y la corrección
 * del último cambio desde la pizarra.
 */
export function assertLecturaNoSuperaActual(
  lectura: number,
  actual: number | null,
): void {
  if (actual != null && lectura > actual) {
    throw new BadRequestException(
      `La lectura de la mantención (${NUM_CL.format(lectura)}) no puede ser mayor que la lectura actual del equipo (${NUM_CL.format(actual)}).`,
    );
  }
}

/** La lectura de una mantención no puede quedar antes que la de la anterior. */
export function assertLecturaNoBajaDeAnterior(
  lectura: number,
  anterior: MaintenanceAnchor | null | undefined,
): void {
  if (anterior && lectura < anterior.counterAt) {
    throw new BadRequestException(
      `La lectura de la mantención (${NUM_CL.format(lectura)}) no puede ser menor que la de la mantención anterior (${NUM_CL.format(anterior.counterAt)}).`,
    );
  }
}

/** Las órdenes que siguen en el tablero del taller (no cerradas ni canceladas). */
const ESTADOS_ABIERTOS: EstadoOT[] = [
  EstadoOT.PENDIENTE,
  EstadoOT.ASIGNADA,
  EstadoOT.EN_PROCESO,
];

/**
 * El equipo ya tiene una orden PREVENTIVA sin cerrar, de cualquier hito o
 * kilometraje. Es el resguardo contra órdenes preventivas duplicadas que
 * comparten el aviso de pauta y el de livianos: contada desde el ancla, la
 * vuelta (o el km) puede no coincidir con el `origenDetalle` de una orden
 * creada con la regla anterior, y mientras haya una abierta no se crea otra.
 * `equipoId` es texto libre: el taller suele guardar el código interno (ver
 * `OrdenesService.resolveEquipmentId`), así que se aceptan ambos.
 */
export async function tienePreventivaAbierta(
  db: Db,
  equipmentId: string,
  internalCode: string,
): Promise<boolean> {
  const abierta = await db.ordenTrabajo.findFirst({
    where: {
      equipoId: { in: [equipmentId, internalCode] },
      origen: 'PREVENTIVO',
      estado: { in: ESTADOS_ABIERTOS },
    },
    select: { id: true },
  });
  return abierta != null;
}

/** El desempate: el mayor contador y, entre iguales, el más reciente. */
const POR_CONTADOR: Prisma.MaintenanceRecordOrderByWithRelationInput[] = [
  { counterAt: 'desc' },
  { doneAt: 'desc' },
];

async function ultimos(
  db: Db,
  equipmentIds: string[],
  filtro: Prisma.MaintenanceRecordWhereInput,
  orderBy: Prisma.MaintenanceRecordOrderByWithRelationInput[],
): Promise<Map<string, MaintenanceAnchor>> {
  const anclas = new Map<string, MaintenanceAnchor>();
  if (equipmentIds.length === 0) return anclas;
  const registros = await db.maintenanceRecord.findMany({
    where: {
      equipmentId: { in: [...new Set(equipmentIds)] },
      ...filtro,
      counterAt: { not: null },
    },
    orderBy,
    select: {
      equipmentId: true,
      milestone: true,
      cycle: true,
      counterAt: true,
      doneAt: true,
      ordenId: true,
    },
  });
  // Vienen del último cambio de la secuencia hacia atrás: el primero de cada
  // equipo es su ancla. Un hito tiene una fila por operación, cada una con el
  // contador de cuando se marcó: manda la última.
  for (const r of registros) {
    if (r.counterAt == null) continue;
    const ancla = anclas.get(r.equipmentId);
    if (!ancla) {
      anclas.set(r.equipmentId, {
        milestone: r.milestone,
        cycle: r.cycle,
        counterAt: r.counterAt,
        doneAt: r.doneAt,
        ordenId: r.ordenId ?? null,
      });
      continue;
    }
    // La orden del cambio es la de cualquier fila del grupo (mismo hito y
    // vuelta): la que manda puede ser una marca de la grilla, sin orden.
    if (
      ancla.ordenId == null &&
      r.ordenId &&
      r.cycle === ancla.cycle &&
      r.milestone === ancla.milestone
    ) {
      ancla.ordenId = r.ordenId;
    }
  }
  return anclas;
}
