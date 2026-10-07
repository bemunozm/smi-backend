import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MaintenancePlan, MaintenancePlanItem } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ChangeLogService,
  type ChangeLogEntry,
  type Editor,
  type FieldChange,
} from '../../change-log/change-log.service';
import {
  computeMaintenanceStatus,
  type MaintenanceStatus,
  type PlanItemForStatus,
} from './maintenance-plan-status';
import type {
  MaintenancePlanItemDto,
  SaveMaintenancePlanDto,
} from './dto/save-maintenance-plan.dto';

type Unidad = 'h' | 'km';

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
    items: PlanItemForStatus[];
    updatedAt: Date;
  } | null;
  status: MaintenanceStatus;
}

export interface MaintenanceStatusRow {
  equipmentId: string;
  unit: Unidad;
  status: MaintenanceStatus;
}

type PlanConFilas = MaintenancePlan & { items: MaintenancePlanItem[] };

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
@Injectable()
export class MaintenancePlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changeLog: ChangeLogService,
  ) {}

  async findForEquipment(equipmentId: string): Promise<MaintenancePlanView> {
    const equipo = await this.equipo(equipmentId);
    const plan = await this.prisma.maintenancePlan.findUnique({
      where: { equipmentId },
      include: { items: true },
    });
    return this.vista(equipo, plan);
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
    const equipos = await this.prisma.equipment.findMany({
      where: { id: { in: planes.map((p) => p.equipmentId) } },
      select: EQUIPO_SELECT,
    });
    const porId = new Map(equipos.map((e) => [e.id, e]));
    return planes.flatMap((plan) => {
      const equipo = porId.get(plan.equipmentId);
      if (!equipo) return [];
      const { unit, counter } = contadorDe(equipo);
      return [
        {
          equipmentId: equipo.id,
          unit,
          status: computeMaintenanceStatus(
            {
              milestones: plan.milestones,
              initialMilestone: plan.initialMilestone,
              items: filas(plan),
            },
            counter,
          ),
        },
      ];
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
    if (actual && cambios.length === 0) return this.vista(equipo, actual);

    const guardado = await this.prisma.$transaction(async (tx) => {
      const plan = await tx.maintenancePlan.upsert({
        where: { equipmentId },
        create: {
          equipmentId,
          milestones: nueva.milestones,
          initialMilestone: nueva.initialMilestone,
        },
        update: {
          milestones: nueva.milestones,
          initialMilestone: nueva.initialMilestone,
        },
      });
      await tx.maintenancePlanItem.deleteMany({ where: { planId: plan.id } });
      await tx.maintenancePlanItem.createMany({
        data: nueva.items.map((i, position) => ({
          planId: plan.id,
          position,
          kind: i.kind,
          description: i.description,
          quantity: i.quantity,
          unit: i.unit,
          partNumber: i.partNumber,
          inventoryItemId: i.inventoryItemId,
          milestones: i.milestones,
        })),
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

    return this.vista(equipo, guardado);
  }

  /** Quién cambió la pauta y qué, del cambio más reciente al más viejo. */
  findChanges(equipmentId: string): Promise<ChangeLogEntry[]> {
    return this.changeLog.findFor('maintenance_plan', equipmentId);
  }

  private async equipo(id: string): Promise<EquipoParaPauta> {
    const equipo = await this.prisma.equipment.findUnique({
      where: { id },
      select: EQUIPO_SELECT,
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');
    return equipo;
  }

  private vista(
    equipo: EquipoParaPauta,
    plan: PlanConFilas | null,
  ): MaintenancePlanView {
    const { unit, counter } = contadorDe(equipo);
    const items = filas(plan);
    const planVista = plan
      ? {
          milestones: [...plan.milestones].sort((a, b) => a - b),
          initialMilestone: plan.initialMilestone,
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
      status: computeMaintenanceStatus(planVista, counter),
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

    return { milestones, initialMilestone, items };
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
