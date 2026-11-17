import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  EstadoOT,
  type MaintenancePlan,
  type MaintenancePlanItem,
  type Prisma,
} from '@prisma/client';

import {
  DOMAIN_EVENTS,
  type PreventiveServiceDueEvent,
} from '../../common/events/domain-events';
import {
  formatBusinessDate,
  todayInBusinessTimeZone,
} from '../../common/dates/business-time';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ChangeLogService,
  type ChangeLogEntry,
  type Editor,
  type FieldChange,
} from '../../change-log/change-log.service';
import {
  computeMaintenanceStatus,
  type MaintenanceAnchor,
  type MaintenanceStatus,
  type NextMaintenance,
  type PlanItemForStatus,
} from './maintenance-plan-status';
import {
  assertLecturaNoBajaDeAnterior,
  assertLecturaNoSuperaActual,
  LIGHT_SERVICE_RECORD_KIND,
  loadLightAnchors,
  loadPlanAnchors,
  tienePreventivaAbierta,
} from './maintenance-anchors';
import { buildBoardRow, type MaintenanceBoardRow } from './maintenance-board';
import type {
  MaintenancePlanItemDto,
  SaveMaintenancePlanDto,
} from './dto/save-maintenance-plan.dto';
import type { SetMaintenanceRecordDto } from './dto/set-maintenance-record.dto';
import type { CorrectLastChangeDto } from './dto/correct-last-change.dto';
import {
  currentCycle,
  cycleColumns,
  type CycleColumn,
} from './maintenance-cycle';

type Unidad = 'h' | 'km';

/** Una vuelta del ciclo de mantenciones, como la muestra la ficha del equipo. */
export interface MaintenanceCycleView {
  equipment: {
    id: string;
    internalCode: string;
    unit: Unidad;
    counter: number | null;
  };
  hasPlan: boolean;
  /** La vuelta en la que va el equipo hoy. */
  currentCycle: number;
  /** La vuelta que se está mostrando. */
  cycle: number;
  cycleLength: number | null;
  cycleStart: number | null;
  cycleEnd: number | null;
  /** Contador con que el equipo entró al sistema: lo anterior se da por hecho. */
  baselineCounter: number | null;
  items: PlanItemForStatus[];
  columns: CycleColumn[];
  records: {
    id: string;
    planItemId: string | null;
    milestone: number;
    description: string;
    kind: string;
    counterAt: number | null;
    doneByName: string;
    doneAt: Date;
  }[];
}

export interface MaintenancePlanView {
  equipment: {
    id: string;
    internalCode: string;
    /** `h` o `km`, según cómo se mide el equipo. */
    unit: Unidad;
    counter: number | null;
  };
  plan: {
    milestones: number[];
    initialMilestone: number | null;
    /** Cuánto antes de la próxima mantención se avisa al mantenedor. */
    alertBefore: number | null;
    items: PlanItemForStatus[];
    updatedAt: Date;
  } | null;
  status: MaintenanceStatus;
}

export interface MaintenanceStatusRow {
  equipmentId: string;
  unit: Unidad;
  alertBefore: number | null;
  status: MaintenanceStatus;
}

type PlanConFilas = MaintenancePlan & { items: MaintenancePlanItem[] };

/** La vuelta en curso y el contador en que empieza cada vuelta (ver `vueltas`). */
interface Vueltas {
  enCurso: number;
  base: (vuelta: number) => number | undefined;
}

/** Sin pauta o sin ancla: vueltas por múltiplos del ciclo, desde la primera. */
const SIN_VUELTAS: Vueltas = { enCurso: 1, base: () => undefined };

const EQUIPO_SELECT = {
  id: true,
  internalCode: true,
  controlUnit: true,
  currentHourmeter: true,
  currentMileage: true,
} as const;

type EquipoParaPauta = {
  id: string;
  internalCode: string;
  controlUnit: string;
  currentHourmeter: number | null;
  currentMileage: number | null;
};

/** El contador de la pauta es el que usa el equipo: horómetro o km. */
function contadorDe(e: EquipoParaPauta): {
  unit: Unidad;
  counter: number | null;
} {
  return e.controlUnit === 'KM'
    ? { unit: 'km', counter: e.currentMileage }
    : { unit: 'h', counter: e.currentHourmeter };
}

function filas(plan: PlanConFilas | null): PlanItemForStatus[] {
  return [...(plan?.items ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      partNumber: i.partNumber,
      inventoryItemId: i.inventoryItemId,
      milestones: [...i.milestones].sort((a, b) => a - b),
    }));
}

const fmt = (n: number) => n.toLocaleString('es-CL');
/**
 * Quién figura en un registro que escribe el sistema sin usuario detrás (las
 * órdenes del aviso no tienen autor).
 */
const SISTEMA_ID = 'sistema';
const lista = (ns: number[]) => (ns.length ? ns.map(fmt).join(', ') : '—');
/** Cómo se lee una fila en el registro de cambios: «24 LT · hitos 250, 500». */
const resumenFila = (f: {
  quantity: number | null;
  unit: string | null;
  milestones: number[];
}) =>
  [
    f.quantity != null
      ? `${fmt(f.quantity)}${f.unit ? ` ${f.unit}` : ''}`
      : null,
    `hitos ${lista(f.milestones)}`,
  ]
    .filter(Boolean)
    .join(' · ');

/**
 * Pautas de mantención preventiva por equipo (ver `MaintenancePlan` en
 * `schema.prisma`). Las arma a mano el mantenedor o el administrador; la
 * próxima mantención de cada equipo la calcula `computeMaintenanceStatus`.
 */
/** Cada cuánto se revisan los avisos preventivos de todos los equipos. */
const REVISION_AVISOS_MS = 5 * 60 * 1000;

@Injectable()
export class MaintenancePlansService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenancePlansService.name);
  private revision: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly changeLog: ChangeLogService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async findForEquipment(equipmentId: string): Promise<MaintenancePlanView> {
    const equipo = await this.equipo(equipmentId);
    const plan = await this.prisma.maintenancePlan.findUnique({
      where: { equipmentId },
      include: { items: true },
    });
    return this.vista(
      equipo,
      plan,
      plan ? await this.ancla(equipmentId) : null,
    );
  }

  /** Solo la próxima mantención: lo que usan las tareas preventivas. */
  async nextForEquipment(equipmentId: string) {
    const { equipment, status } = await this.findForEquipment(equipmentId);
    return { equipmentId, unit: equipment.unit, ...status };
  }

  /**
   * La próxima mantención de todos los equipos que tienen pauta, en una
   * consulta: la tabla de Equipos la muestra en cada fila sin pedirla de a una.
   */
  async statusForAll(): Promise<MaintenanceStatusRow[]> {
    const planes = await this.prisma.maintenancePlan.findMany({
      include: { items: true },
    });
    if (planes.length === 0) return [];
    const ids = planes.map((p) => p.equipmentId);
    const [equipos, anclas] = await Promise.all([
      this.prisma.equipment.findMany({
        where: { id: { in: ids } },
        select: EQUIPO_SELECT,
      }),
      loadPlanAnchors(this.prisma, ids),
    ]);
    const porId = new Map(equipos.map((e) => [e.id, e]));
    return planes.flatMap((plan) => {
      const equipo = porId.get(plan.equipmentId);
      if (!equipo) return [];
      const { unit, counter } = contadorDe(equipo);
      return [
        {
          equipmentId: equipo.id,
          unit,
          alertBefore: plan.alertBefore,
          status: computeMaintenanceStatus(
            {
              milestones: plan.milestones,
              initialMilestone: plan.initialMilestone,
              items: filas(plan),
            },
            counter,
            anclas.get(equipo.id) ?? null,
          ),
        },
      ];
    });
  }

  /**
   * La pizarra de mantenciones: una fila por equipo (también los fuera de
   * servicio), en un número fijo de consultas. Aquí solo se leen los datos;
   * las reglas las arma `buildBoardRow`. El orden es cosa del frontend.
   */
  board(): Promise<MaintenanceBoardRow[]> {
    return this.filasPizarra();
  }

  /**
   * Las filas de la pizarra; con `equipmentId`, solo la de ese equipo (la
   * que devuelve una corrección), con las mismas reglas que la pizarra entera.
   */
  private async filasPizarra(
    equipmentId?: string,
  ): Promise<MaintenanceBoardRow[]> {
    const soloEquipo = equipmentId ? { equipmentId } : undefined;
    const [equipos, planes, configs] = await Promise.all([
      this.prisma.equipment.findMany({
        where: equipmentId ? { id: equipmentId } : undefined,
        select: {
          ...EQUIPO_SELECT,
          type: true,
          brand: true,
          model: true,
          equipmentClass: true,
          status: true,
        },
      }),
      this.prisma.maintenancePlan.findMany({
        where: soloEquipo,
        include: { items: true },
      }),
      this.prisma.lightVehicleConfig.findMany({
        where: soloEquipo,
        select: { equipmentId: true, serviceAlertKm: true },
      }),
    ]);
    const planDe = new Map(planes.map((p) => [p.equipmentId, p]));
    const sinPautaLivianos = equipos
      .filter(
        (e) =>
          !planDe.has(e.id) &&
          e.equipmentClass === 'LIGHT' &&
          e.controlUnit === 'KM',
      )
      .map((e) => e.id);
    const [anclasPauta, anclasLivianos] = await Promise.all([
      loadPlanAnchors(
        this.prisma,
        planes.map((p) => p.equipmentId),
      ),
      loadLightAnchors(this.prisma, sinPautaLivianos),
    ]);
    const avisoKm = new Map(
      configs.map((c) => [c.equipmentId, c.serviceAlertKm]),
    );
    return equipos.map((equipo) => {
      const plan = planDe.get(equipo.id);
      return buildBoardRow({
        equipo,
        plan: plan
          ? {
              milestones: plan.milestones,
              initialMilestone: plan.initialMilestone,
              alertBefore: plan.alertBefore,
              items: filas(plan),
            }
          : null,
        planAnchor: anclasPauta.get(equipo.id) ?? null,
        lightAnchor: anclasLivianos.get(equipo.id) ?? null,
        lightAlertKm: avisoKm.get(equipo.id) ?? null,
      });
    });
  }

  /**
   * Guarda la pauta entera de un equipo, como se edita: hitos, filas y marcas.
   * Reemplaza las filas en la misma transacción que deja el registro de
   * quién cambió qué; si nada cambió de verdad, no se escribe nada.
   */
  async save(
    equipmentId: string,
    dto: SaveMaintenancePlanDto,
    editor: Editor,
  ): Promise<MaintenancePlanView> {
    const equipo = await this.equipo(equipmentId);
    const nueva = await this.validar(dto);

    const actual = await this.prisma.maintenancePlan.findUnique({
      where: { equipmentId },
      include: { items: true },
    });
    const cambios = this.cambios(actual, nueva);
    if (actual && cambios.length === 0) {
      return this.vista(equipo, actual, await this.ancla(equipmentId));
    }

    const guardado = await this.prisma.$transaction(async (tx) => {
      const plan = await tx.maintenancePlan.upsert({
        where: { equipmentId },
        create: {
          equipmentId,
          milestones: nueva.milestones,
          initialMilestone: nueva.initialMilestone,
          alertBefore: nueva.alertBefore,
          // Desde acá se lleva el equipo en el sistema: lo que vencía antes se
          // da por hecho. Solo al crear la pauta; editarla no lo mueve.
          baselineCounter: contadorDe(equipo).counter,
        },
        update: {
          milestones: nueva.milestones,
          initialMilestone: nueva.initialMilestone,
          alertBefore: nueva.alertBefore,
        },
      });
      // Las filas que ya existían se ACTUALIZAN, no se recrean: su id es lo
      // que ata el registro de mantenciones hechas (`MaintenanceRecord`) a la
      // operación. Recrearlas en cada guardado dejaría ese registro huérfano.
      const existentes = new Set((actual?.items ?? []).map((i) => i.id));
      const conservadas = new Set<string>();
      for (const [position, i] of nueva.items.entries()) {
        const data = {
          position,
          kind: i.kind,
          description: i.description,
          quantity: i.quantity,
          unit: i.unit,
          partNumber: i.partNumber,
          inventoryItemId: i.inventoryItemId,
          milestones: i.milestones,
        };
        if (i.id && existentes.has(i.id)) {
          conservadas.add(i.id);
          await tx.maintenancePlanItem.update({ where: { id: i.id }, data });
        } else {
          // La fila nueva también se CONSERVA: el barrido de abajo borra lo
          // que ya no está en la pauta, y sin su id acá se llevaba puesto lo
          // recién creado — la pauta se guardaba sin operaciones.
          const creada = await tx.maintenancePlanItem.create({
            data: { ...data, planId: plan.id },
            select: { id: true },
          });
          conservadas.add(creada.id);
        }
      }
      await tx.maintenancePlanItem.deleteMany({
        where: { planId: plan.id, id: { notIn: [...conservadas] } },
      });
      await this.changeLog.record(
        tx,
        'maintenance_plan',
        equipmentId,
        editor,
        cambios,
      );
      return tx.maintenancePlan.findUniqueOrThrow({
        where: { id: plan.id },
        include: { items: true },
      });
    });

    // Con el umbral recién puesto, el equipo puede ya estar dentro del margen.
    await this.checkAlert(equipmentId);
    return this.vista(equipo, guardado, await this.ancla(equipmentId));
  }

  /**
   * El administrador corrige desde la pizarra la fecha y la lectura del
   * último cambio (un error de tipeo). Se corrigen TODOS los registros de ese
   * cambio —en la pauta, una fila por operación del hito y vuelta; en un
   * liviano sin pauta, su servicio—, sin mover el hito ni la vuelta. Todo se
   * valida antes de escribir y queda en el registro de cambios de la pauta.
   */
  async correctLastChange(
    equipmentId: string,
    dto: CorrectLastChangeDto,
    editor: Editor,
  ): Promise<MaintenanceBoardRow> {
    const equipo = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { ...EQUIPO_SELECT, equipmentClass: true },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');
    const { unit, counter } = contadorDe(equipo);

    // El ancla es la misma que muestra la pizarra: la de la pauta si tiene;
    // si no, el servicio del liviano en km.
    const plan = await this.prisma.maintenancePlan.findUnique({
      where: { equipmentId },
      select: { id: true },
    });
    const liviano = !plan && equipo.equipmentClass === 'LIGHT' && unit === 'km';
    const ancla = plan
      ? (await loadPlanAnchors(this.prisma, [equipmentId])).get(equipmentId)
      : liviano
        ? (await loadLightAnchors(this.prisma, [equipmentId])).get(equipmentId)
        : undefined;
    if (!ancla) {
      throw new BadRequestException(
        'El equipo no tiene un último cambio registrado.',
      );
    }

    // Futuro no, como en la mantención anterior: hoy (en horario de faena) sí.
    if (dto.doneAt > todayInBusinessTimeZone(new Date())) {
      throw new BadRequestException(
        'La fecha del último cambio no puede ser futura.',
      );
    }
    assertLecturaNoSuperaActual(dto.counterAt, counter);
    // La anterior es la del mismo tipo de ancla, sin el propio cambio: si no,
    // corregir la lectura hacia abajo chocaría consigo misma.
    const anteriores = plan
      ? await loadPlanAnchors(this.prisma, [equipmentId], {
          cycle: ancla.cycle,
          milestone: ancla.milestone,
        })
      : await loadLightAnchors(this.prisma, [equipmentId], {
          cycle: ancla.cycle,
        });
    const anterior = anteriores.get(equipmentId);
    assertLecturaNoBajaDeAnterior(dto.counterAt, anterior);
    // Tampoco puede quedar antes que el cambio previo: el mismo día sí.
    if (anterior && dto.doneAt < todayInBusinessTimeZone(anterior.doneAt)) {
      throw new BadRequestException(
        'La fecha del último cambio no puede ser anterior a la del cambio previo.',
      );
    }

    const etiquetaContador = unit === 'km' ? 'Kilometraje' : 'Horómetro';
    const cambios: FieldChange[] = [];
    const antesFecha = formatBusinessDate(ancla.doneAt);
    // Mediodía UTC, como la mantención anterior: a medianoche UTC la UI (en
    // hora de Chile) mostraría el día anterior.
    const doneAt = new Date(`${dto.doneAt}T12:00:00.000Z`);
    const despuesFecha = formatBusinessDate(doneAt);
    if (antesFecha !== despuesFecha) {
      cambios.push({
        field: 'lastChange.doneAt',
        label: 'Fecha último cambio',
        before: antesFecha,
        after: despuesFecha,
      });
    }
    if (ancla.counterAt !== dto.counterAt) {
      cambios.push({
        field: 'lastChange.counterAt',
        label: `${etiquetaContador} último cambio`,
        before: `${fmt(ancla.counterAt)} ${unit}`,
        after: `${fmt(dto.counterAt)} ${unit}`,
      });
    }

    if (cambios.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.maintenanceRecord.updateMany({
          where: plan
            ? {
                equipmentId,
                planItemId: { not: null },
                cycle: ancla.cycle,
                milestone: ancla.milestone,
              }
            : {
                equipmentId,
                planItemId: null,
                kind: LIGHT_SERVICE_RECORD_KIND,
                cycle: ancla.cycle,
              },
          data: { counterAt: dto.counterAt, doneAt },
        });
        await this.changeLog.record(
          tx,
          'maintenance_plan',
          equipmentId,
          editor,
          cambios,
        );
      });
      // Con el ancla corregida la próxima mantención puede quedar dentro del
      // margen de aviso. El de un liviano sin pauta lo crea la revisión
      // periódica de `VencimientosService` (que ya depende de este servicio:
      // llamarla desde acá sería una dependencia circular).
      if (plan) await this.checkAlert(equipmentId);
    }

    const [fila] = await this.filasPizarra(equipmentId);
    return fila;
  }

  onModuleInit(): void {
    // En los tests no corre: cada suite levantaría su propio intervalo.
    if (process.env.NODE_ENV === 'test') return;
    this.revision = setInterval(() => void this.checkAll(), REVISION_AVISOS_MS);
    this.revision.unref();
  }

  onModuleDestroy(): void {
    if (this.revision) clearInterval(this.revision);
  }

  /**
   * Revisa todos los equipos con aviso configurado. Corre cada pocos minutos:
   * el horómetro lo mueven Flota y Terreno por su cuenta, y esta revisión es
   * lo que convierte «faltan 40 h» en una tarjeta del mantenedor sin que esos
   * módulos tengan que saber de pautas.
   */
  async checkAll(): Promise<number> {
    const planes = await this.prisma.maintenancePlan.findMany({
      where: { alertBefore: { not: null } },
      select: { equipmentId: true },
    });
    let creadas = 0;
    for (const { equipmentId } of planes) {
      try {
        if (await this.checkAlert(equipmentId)) creadas++;
      } catch (error) {
        this.logger.error(
          `No se pudo revisar el aviso preventivo del equipo "${equipmentId}"`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
    return creadas;
  }

  /**
   * Si la próxima mantención del equipo cae dentro del margen de aviso de su
   * pauta, crea la orden PREVENTIVA con las operaciones de ese hito como
   * tareas: es la tarjeta que el mantenedor ve en su tablero. Una sola por
   * equipo, hito y vuelta del ciclo — aunque la revisión corra muchas veces
   * o la orden ya se haya cerrado; una cancelada solo frena hasta que la
   * mantención se atrasa — y ninguna mientras el equipo tenga otra preventiva
   * abierta. Devuelve el id de la orden creada, o null si no correspondía
   * crear ninguna.
   */
  async checkAlert(equipmentId: string): Promise<string | null> {
    const plan = await this.prisma.maintenancePlan.findUnique({
      where: { equipmentId },
      include: { items: true },
    });
    if (!plan || plan.alertBefore == null) return null;
    const equipo = await this.equipo(equipmentId);
    const { unit, counter } = contadorDe(equipo);
    const items = filas(plan);
    const { next, estimated } = computeMaintenanceStatus(
      {
        milestones: plan.milestones,
        initialMilestone: plan.initialMilestone,
        items,
      },
      counter,
      await this.ancla(equipmentId),
    );
    if (!next || next.items.length === 0 || next.remaining > plan.alertBefore) {
      return null;
    }
    // Lo que vencía antes de entrar al sistema ya está hecho. Solo vale para
    // el respaldo sin ancla: con un cambio real registrado, lo que sigue a él
    // toca aunque su contador sea anterior a la entrada del equipo.
    if (
      estimated &&
      plan.baselineCounter != null &&
      next.dueAt < plan.baselineCounter
    ) {
      return null;
    }

    // La vuelta la da la próxima: con ancla sale del último cambio, no del
    // contador absoluto en que toca.
    const cycle = next.cycle;
    // Si el mantenedor ya la registró completa en el ciclo, no hay nada que avisar.
    const hechas = await this.prisma.maintenanceRecord.count({
      where: {
        equipmentId,
        cycle,
        milestone: next.milestone,
        planItemId: { in: next.items.map((i) => i.id) },
      },
    });
    if (hechas >= next.items.length) return null;

    // Es lo que identifica la orden de este hito y esta vuelta; también lo que
    // muestra el tablero como origen.
    const origenDetalle = next.firstTimeOnly
      ? `Pauta: servicio inicial de ${fmt(next.milestone)} ${unit}`
      : `Pauta: ${fmt(next.milestone)} ${unit} · ciclo ${cycle}`;

    const ordenId = await this.prisma.$transaction(async (tx) => {
      // Dos revisiones a la vez (la periódica y un guardado) no pueden crear
      // dos tarjetas: se serializan por equipo dentro de la transacción.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`aviso-preventivo:${equipmentId}`}))`;
      const previas = await tx.ordenTrabajo.findMany({
        where: { equipoId: equipmentId, origen: 'PREVENTIVO', origenDetalle },
        select: {
          id: true,
          estado: true,
          pautaCycle: true,
          pautaMilestone: true,
          updatedAt: true,
          createdById: true,
          tareas: { select: { planItemId: true, texto: true } },
        },
      });
      // Una orden de pauta de este hito que se cerró antes de que el cierre
      // escribiera el ancla: el hito quedó sin registro y, contada desde el
      // ancla, la próxima sigue siendo esta para siempre. Se escribe su
      // registro con la fecha de su cierre y no se crea otra: la próxima
      // revisión ya cuenta desde ella.
      const cerrada = previas.find(
        (o) =>
          o.estado === EstadoOT.COMPLETADA &&
          o.pautaCycle === cycle &&
          o.pautaMilestone === next.milestone,
      );
      if (cerrada) {
        await this.repararCierrePrevio(tx, equipmentId, cerrada, next, items);
        this.logger.log(
          `Registro de pauta reparado para ${equipo.internalCode}: ${origenDetalle} (orden ${cerrada.id} cerrada sin registro)`,
        );
        return null;
      }
      // Una cancelada frena el aviso hasta que la mantención se atrasa: desde
      // ahí la cancelación no puede dejar al equipo sin tarjeta para siempre.
      const frena = previas.some(
        (o) => o.estado !== EstadoOT.CANCELADA || next.remaining > 0,
      );
      if (frena) return null;
      // Ni otra mientras haya una preventiva abierta de cualquier hito.
      if (await tienePreventivaAbierta(tx, equipmentId, equipo.internalCode)) {
        return null;
      }
      const orden = await tx.ordenTrabajo.create({
        data: {
          equipoId: equipmentId,
          titulo: `Mantención preventiva ${fmt(next.milestone)} ${unit} · ${equipo.internalCode}`,
          tipo: 'PREVENTIVA',
          origen: 'PREVENTIVO',
          origenDetalle,
          // El hito y la vuelta quedan como datos: el checklist de la tarjeta
          // escribe el registro del ciclo sin parsear `origenDetalle`.
          pautaMilestone: next.milestone,
          pautaCycle: cycle,
          // Si ya toca o se pasó (con ancla lo que falta queda negativo),
          // sube de prioridad.
          prioridad: next.remaining <= 0 ? 'ALTA' : 'MEDIA',
          tareas: {
            create: next.items.map((i, posicion) => ({
              texto: [
                i.description,
                i.quantity != null
                  ? `${fmt(i.quantity)}${i.unit ? ` ${i.unit}` : ''}`
                  : null,
                i.partNumber ? `cód. ${i.partNumber}` : null,
              ]
                .filter(Boolean)
                .join(' · '),
              posicion,
              // Ata la tarea a su operación de la pauta (ver `TareaOT.planItemId`).
              planItemId: i.id,
            })),
          },
        },
        select: { id: true },
      });
      this.logger.log(
        `Orden preventiva creada para ${equipo.internalCode}: ${origenDetalle} (faltan ${fmt(next.remaining)} ${unit})`,
      );
      return orden.id;
    });

    if (ordenId) {
      // Recién confirmada la orden: el aviso al mantenedor y al administrador
      // sale una sola vez, junto con la tarjeta (ver NotificationsListener).
      this.eventEmitter.emit(DOMAIN_EVENTS.PREVENTIVE_SERVICE_DUE, {
        equipmentId,
        equipmentCode: equipo.internalCode,
        ordenId,
        milestone: next.milestone,
        unit,
        remaining: next.remaining,
      } satisfies PreventiveServiceDueEvent);
    }
    return ordenId;
  }

  /**
   * Escribe el registro del ciclo de una orden de pauta cerrada antes de que
   * el cierre lo hiciera (ver `checkAlert`): una fila por tarea atada a una
   * operación, con el contador en que tocaba el hito y la fecha del cierre.
   */
  private async repararCierrePrevio(
    tx: Prisma.TransactionClient,
    equipmentId: string,
    orden: {
      updatedAt: Date;
      createdById: string | null;
      tareas: { planItemId: string | null; texto: string }[];
    },
    next: NextMaintenance,
    items: PlanItemForStatus[],
  ): Promise<void> {
    const porId = new Map(items.map((i) => [i.id, i]));
    await tx.maintenanceRecord.createMany({
      data: orden.tareas.flatMap((t) => {
        if (!t.planItemId) return [];
        const item = porId.get(t.planItemId);
        return [
          {
            equipmentId,
            planItemId: t.planItemId,
            // Son los de la orden: solo se repara la del hito y vuelta que toca.
            cycle: next.cycle,
            milestone: next.milestone,
            description: item?.description ?? t.texto,
            kind: item?.kind ?? 'OTRO',
            counterAt: next.dueAt,
            doneAt: orden.updatedAt,
            // Las órdenes del aviso no tienen autor: las creó el sistema.
            doneById: orden.createdById ?? SISTEMA_ID,
            doneByName: 'Sistema (cierre previo)',
          },
        ];
      }),
      // Alguna operación pudo quedar marcada desde la grilla: no se duplica.
      skipDuplicates: true,
    });
  }

  /** Quién cambió la pauta y qué, del cambio más reciente al más viejo. */
  findChanges(equipmentId: string): Promise<ChangeLogEntry[]> {
    return this.changeLog.findFor('maintenance_plan', equipmentId);
  }

  /**
   * Una vuelta del ciclo de mantenciones del equipo: las operaciones de su
   * pauta, las columnas de hitos con su avance y lo ya hecho en esa vuelta.
   * Sin `cycle` devuelve la vuelta en curso.
   */
  async getCycle(
    equipmentId: string,
    cycle?: number,
  ): Promise<MaintenanceCycleView> {
    const equipo = await this.equipo(equipmentId);
    const { unit, counter } = contadorDe(equipo);
    const plan = await this.prisma.maintenancePlan.findUnique({
      where: { equipmentId },
      include: { items: true },
    });
    const items = filas(plan);
    const milestones = [...(plan?.milestones ?? [])].sort((a, b) => a - b);
    const cycleLength = milestones[milestones.length - 1] ?? null;
    const { enCurso, base } = plan
      ? this.vueltas(plan, counter, await this.ancla(equipmentId))
      : SIN_VUELTAS;
    const vuelta = cycle ?? enCurso;
    if (vuelta < 1 || vuelta > enCurso) {
      throw new BadRequestException(
        `El ciclo ${vuelta} no existe: el equipo va en el ciclo ${enCurso}.`,
      );
    }

    // Con ancla la vuelta empieza en su origen, no en un múltiplo del ciclo.
    // Las vueltas pasadas se rearman desde el origen del ancla de hoy.
    const inicio =
      cycleLength != null ? (base(vuelta) ?? (vuelta - 1) * cycleLength) : null;
    const records = plan
      ? await this.prisma.maintenanceRecord.findMany({
          where: { equipmentId, cycle: vuelta },
          orderBy: { doneAt: 'asc' },
        })
      : [];

    return {
      equipment: {
        id: equipo.id,
        internalCode: equipo.internalCode,
        unit,
        counter,
      },
      hasPlan: plan != null,
      currentCycle: enCurso,
      cycle: vuelta,
      cycleLength,
      cycleStart: inicio,
      cycleEnd:
        inicio != null && cycleLength != null ? inicio + cycleLength : null,
      baselineCounter: plan?.baselineCounter ?? null,
      items,
      columns: plan
        ? cycleColumns({
            milestones,
            initialMilestone: plan.initialMilestone,
            items,
            records,
            cycle: vuelta,
            counter,
            baselineCounter: plan.baselineCounter,
            cycleBase: base(vuelta),
          })
        : [],
      records: records.map((r) => ({
        id: r.id,
        planItemId: r.planItemId,
        milestone: r.milestone,
        description: r.description,
        kind: r.kind,
        counterAt: r.counterAt,
        doneByName: r.doneByName,
        doneAt: r.doneAt,
      })),
    };
  }

  /**
   * Marca (o desmarca) una operación de la pauta como hecha en un hito de una
   * vuelta del ciclo. Queda quién, cuándo y con qué contador. Solo se puede
   * registrar en la vuelta en curso o en una anterior, y en un hito donde esa
   * operación figura en la pauta.
   */
  async setRecord(
    equipmentId: string,
    dto: SetMaintenanceRecordDto,
    editor: Editor,
  ): Promise<MaintenanceCycleView> {
    const equipo = await this.equipo(equipmentId);
    const { counter } = contadorDe(equipo);
    const plan = await this.prisma.maintenancePlan.findUnique({
      where: { equipmentId },
      include: { items: true },
    });
    if (!plan) {
      throw new BadRequestException(
        'El equipo todavía no tiene pauta de mantención.',
      );
    }
    const item = plan.items.find((i) => i.id === dto.planItemId);
    if (!item) {
      throw new NotFoundException(
        'Esa operación no es de la pauta de este equipo.',
      );
    }
    const { enCurso, base } = this.vueltas(
      plan,
      counter,
      await this.ancla(equipmentId),
    );
    if (dto.cycle > enCurso) {
      throw new BadRequestException(
        `No se puede registrar en el ciclo ${dto.cycle}: el equipo va en el ciclo ${enCurso}.`,
      );
    }
    const esInicial =
      plan.initialMilestone != null && dto.milestone === plan.initialMilestone;
    if (esInicial && dto.cycle !== 1) {
      throw new BadRequestException(
        'El servicio inicial solo existe en el primer ciclo.',
      );
    }
    if (!item.milestones.includes(dto.milestone)) {
      throw new BadRequestException(
        `«${item.description}» no se hace a las ${fmt(dto.milestone)} según la pauta.`,
      );
    }

    // Las mantenciones se registran en orden dentro de la vuelta: la de 500 h
    // no se marca con la de 250 h a medias, y la de 250 h no se desmarca con
    // la de 500 h ya registrada.
    const registros = await this.prisma.maintenanceRecord.findMany({
      where: { equipmentId, cycle: dto.cycle },
    });
    const columnas = cycleColumns({
      milestones: plan.milestones,
      initialMilestone: plan.initialMilestone,
      items: filas(plan),
      records: registros,
      cycle: dto.cycle,
      counter,
      baselineCounter: plan.baselineCounter,
      cycleBase: base(dto.cycle),
    });
    const columna = columnas.find((c) => c.milestone === dto.milestone);
    if (columna?.preSystem) {
      throw new BadRequestException(
        `La mantención de ${fmt(dto.milestone)} es anterior a que el equipo entrara al sistema: se da por hecha.`,
      );
    }
    if (columna && dto.done && !columna.unlocked) {
      const falta = columnas.find(
        (c) => c.milestone !== dto.milestone && c.total > 0 && !c.complete,
      );
      throw new BadRequestException(
        `Primero hay que completar la mantención de ${fmt(falta?.milestone ?? 0)}: se hacen en orden.`,
      );
    }
    if (columna && !dto.done && !columna.canUndo) {
      throw new BadRequestException(
        `No se puede desmarcar: ya hay mantenciones registradas después de las ${fmt(dto.milestone)}.`,
      );
    }

    if (dto.done) {
      await this.prisma.maintenanceRecord.upsert({
        where: {
          planItemId_cycle_milestone: {
            planItemId: item.id,
            cycle: dto.cycle,
            milestone: dto.milestone,
          },
        },
        create: {
          equipmentId,
          planItemId: item.id,
          cycle: dto.cycle,
          milestone: dto.milestone,
          description: item.description,
          kind: item.kind,
          counterAt: counter,
          doneById: editor.id,
          doneByName: editor.name,
        },
        // Ya estaba hecha: no se pisa quién y cuándo la hizo.
        update: {},
      });
    } else {
      await this.prisma.maintenanceRecord.deleteMany({
        where: {
          planItemId: item.id,
          cycle: dto.cycle,
          milestone: dto.milestone,
        },
      });
    }
    return this.getCycle(equipmentId, dto.cycle);
  }

  private async equipo(id: string): Promise<EquipoParaPauta> {
    const equipo = await this.prisma.equipment.findUnique({
      where: { id },
      select: EQUIPO_SELECT,
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');
    return equipo;
  }

  /** El último cambio real de la pauta del equipo, o null si nunca registró uno. */
  private async ancla(equipmentId: string): Promise<MaintenanceAnchor | null> {
    const anclas = await loadPlanAnchors(this.prisma, [equipmentId]);
    return anclas.get(equipmentId) ?? null;
  }

  /**
   * En qué vuelta va el equipo y dónde empieza cada una (`base`, el contador
   * de su hito 0). Sin ancla, las vueltas son múltiplos del ciclo sobre el
   * contador: `base` no da nada y `cycleColumns` usa esos múltiplos. Con
   * ancla, la vuelta en curso es la de la próxima mantención —o la del ancla
   * si no hay lectura— y las demás empiezan un ciclo antes o después.
   */
  private vueltas(
    plan: PlanConFilas,
    counter: number | null,
    anchor: MaintenanceAnchor | null,
  ): Vueltas {
    const cycleLength = Math.max(...plan.milestones);
    if (!anchor) {
      return { ...SIN_VUELTAS, enCurso: currentCycle(counter, cycleLength) };
    }
    const { next, cycleOrigin } = computeMaintenanceStatus(
      {
        milestones: plan.milestones,
        initialMilestone: plan.initialMilestone,
        items: [],
      },
      counter,
      anchor,
    );
    const enCurso = next?.cycle ?? anchor.cycle;
    // Sin lectura no hay próxima: la vuelta del ancla empieza en su contador
    // menos su hito.
    const origen = cycleOrigin ?? anchor.counterAt - anchor.milestone;
    return {
      enCurso,
      base: (vuelta) => origen + (vuelta - enCurso) * cycleLength,
    };
  }

  private vista(
    equipo: EquipoParaPauta,
    plan: PlanConFilas | null,
    anchor: MaintenanceAnchor | null,
  ): MaintenancePlanView {
    const { unit, counter } = contadorDe(equipo);
    const items = filas(plan);
    const planVista = plan
      ? {
          milestones: [...plan.milestones].sort((a, b) => a - b),
          initialMilestone: plan.initialMilestone,
          alertBefore: plan.alertBefore,
          items,
          updatedAt: plan.updatedAt,
        }
      : null;
    return {
      equipment: {
        id: equipo.id,
        internalCode: equipo.internalCode,
        unit,
        counter,
      },
      plan: planVista,
      status: computeMaintenanceStatus(planVista, counter, anchor),
    };
  }

  /**
   * Normaliza y valida la pauta que llegó. Lo que cruza campos no lo puede
   * decir el DTO: que cada marca caiga en un hito que existe y que el servicio
   * inicial vaya antes del primer hito.
   */
  private async validar(dto: SaveMaintenancePlanDto) {
    const milestones = [...new Set(dto.milestones)].sort((a, b) => a - b);
    if (milestones.length === 0) {
      throw new BadRequestException('La pauta necesita al menos un hito.');
    }
    const initialMilestone = dto.initialMilestone ?? null;
    if (initialMilestone != null && initialMilestone >= milestones[0]) {
      throw new BadRequestException(
        `El servicio inicial (${fmt(initialMilestone)}) tiene que ir antes del primer hito (${fmt(milestones[0])}).`,
      );
    }
    const validos = new Set([
      ...milestones,
      ...(initialMilestone != null ? [initialMilestone] : []),
    ]);

    const items = dto.items.map((i: MaintenancePlanItemDto) => {
      const marcas = [...new Set(i.milestones)].sort((a, b) => a - b);
      const ajena = marcas.find((m) => !validos.has(m));
      if (ajena != null) {
        throw new BadRequestException(
          `«${i.description.trim()}» está marcada en ${fmt(ajena)}, que no es un hito de la pauta.`,
        );
      }
      return {
        id: i.id ?? null,
        kind: i.kind,
        description: i.description.trim(),
        quantity: i.quantity ?? null,
        unit: i.unit?.trim() || null,
        partNumber: i.partNumber?.trim() || null,
        inventoryItemId: i.inventoryItemId || null,
        milestones: marcas,
      };
    });

    const repuestos = [
      ...new Set(items.map((i) => i.inventoryItemId).filter(Boolean)),
    ] as string[];
    if (repuestos.length) {
      const existentes = await this.prisma.inventoryItem.count({
        where: { id: { in: repuestos } },
      });
      if (existentes !== repuestos.length) {
        throw new BadRequestException(
          'Uno de los repuestos elegidos ya no existe en el inventario.',
        );
      }
    }

    return {
      milestones,
      initialMilestone,
      alertBefore: dto.alertBefore ?? null,
      items,
    };
  }

  /**
   * Lo que cambió entre la pauta guardada y la nueva, legible para quien
   * revisa: los hitos, el servicio inicial y cada operación agregada,
   * quitada o modificada (por su descripción).
   */
  private cambios(
    actual: PlanConFilas | null,
    nueva: Awaited<ReturnType<MaintenancePlansService['validar']>>,
  ): FieldChange[] {
    const cambios: FieldChange[] = [];
    const antesHitos = lista(
      [...(actual?.milestones ?? [])].sort((a, b) => a - b),
    );
    const despuesHitos = lista(nueva.milestones);
    if (antesHitos !== despuesHitos) {
      cambios.push({
        field: 'milestones',
        label: 'Hitos',
        before: antesHitos,
        after: despuesHitos,
      });
    }
    const antesInicial =
      actual?.initialMilestone != null ? fmt(actual.initialMilestone) : '—';
    const despuesInicial =
      nueva.initialMilestone != null ? fmt(nueva.initialMilestone) : '—';
    if (antesInicial !== despuesInicial) {
      cambios.push({
        field: 'initialMilestone',
        label: 'Servicio inicial',
        before: antesInicial,
        after: despuesInicial,
      });
    }

    const antesAviso =
      actual?.alertBefore != null ? fmt(actual.alertBefore) : 'sin aviso';
    const despuesAviso =
      nueva.alertBefore != null ? fmt(nueva.alertBefore) : 'sin aviso';
    if (antesAviso !== despuesAviso) {
      cambios.push({
        field: 'alertBefore',
        label: 'Aviso al mantenedor (antes de la mantención)',
        before: antesAviso,
        after: despuesAviso,
      });
    }

    const antes = new Map(filas(actual).map((f) => [f.description, f]));
    const despues = new Map(nueva.items.map((f) => [f.description, f]));
    for (const [desc, f] of despues) {
      const previa = antes.get(desc);
      const ahora = resumenFila(f);
      if (!previa) {
        cambios.push({
          field: `item:${desc}`,
          label: desc,
          before: '—',
          after: ahora,
        });
      } else if (resumenFila(previa) !== ahora) {
        cambios.push({
          field: `item:${desc}`,
          label: desc,
          before: resumenFila(previa),
          after: ahora,
        });
      }
    }
    for (const [desc, f] of antes) {
      if (!despues.has(desc)) {
        cambios.push({
          field: `item:${desc}`,
          label: desc,
          before: resumenFila(f),
          after: 'quitada',
        });
      }
    }
    return cambios;
  }
}
