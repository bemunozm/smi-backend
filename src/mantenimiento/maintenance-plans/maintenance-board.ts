/**
 * La fila de cada equipo en la pizarra de mantenciones. Es una función pura
 * —sin base de datos— que usa las mismas reglas que el estado de la pauta y
 * el de los livianos (`computeMaintenanceStatus`, `nextLightService`): la
 * pizarra no puede mostrar un «próximo cambio» distinto al del aviso.
 */
import type { EquipmentStatus } from '@prisma/client';

import {
  LIGHT_SERVICE_ALERT_KM,
  LIGHT_SERVICE_INTERVAL_KM,
  nextLightService,
} from '../vencimientos/vencimientos-rules';
import {
  computeMaintenanceStatus,
  type MaintenanceAnchor,
  type PlanItemForStatus,
} from './maintenance-plan-status';

export interface MaintenanceBoardRow {
  equipmentId: string;
  internalCode: string;
  type: string;
  brand: string | null;
  model: string | null;
  equipmentClass: 'HEAVY' | 'LIGHT';
  unit: 'h' | 'km';
  status: EquipmentStatus;
  counter: number | null;
  source: 'PAUTA' | 'LIVIANO' | 'SIN_PAUTA';
  /** Los hitos de la pauta y el servicio inicial: opciones de «mantención anterior». */
  milestones: number[];
  initialMilestone: number | null;
  /** El último cambio real (el ancla); `null` si el equipo nunca registró uno. */
  lastChange: { milestone: number; counterAt: number; doneAt: string } | null;
  /** Horas o km entre un cambio y el siguiente. */
  interval: number | null;
  nextMilestone: number | null;
  dueAt: number | null;
  remaining: number | null;
  /** Cuánto antes de la próxima mantención se avisa. */
  alertBefore: number | null;
  /** Sin ancla: la próxima sale de los hitos absolutos, no de un cambio real. */
  estimated: boolean;
  /** Las operaciones del próximo hito. */
  items: PlanItemForStatus[];
}

export interface BoardEquipment {
  id: string;
  internalCode: string;
  type: string;
  brand: string | null;
  model: string | null;
  equipmentClass: string;
  controlUnit: string;
  status: EquipmentStatus;
  currentHourmeter: number | null;
  currentMileage: number | null;
}

export interface BoardPlan {
  milestones: number[];
  initialMilestone: number | null;
  alertBefore: number | null;
  items: PlanItemForStatus[];
}

export interface BoardRowInput {
  equipo: BoardEquipment;
  /** La pauta del equipo, si tiene. */
  plan: BoardPlan | null;
  /** El último cambio de la pauta (si tiene pauta). */
  planAnchor: MaintenanceAnchor | null;
  /** El último servicio de un liviano sin pauta. */
  lightAnchor: MaintenanceAnchor | null;
  /** Los km de aviso configurados del liviano; sin ellos, el de defecto. */
  lightAlertKm: number | null;
}

const lastChangeDe = (a: MaintenanceAnchor | null) =>
  a
    ? {
        milestone: a.milestone,
        counterAt: a.counterAt,
        doneAt: a.doneAt.toISOString(),
      }
    : null;

export function buildBoardRow(input: BoardRowInput): MaintenanceBoardRow {
  const { equipo, plan } = input;
  const esKm = equipo.controlUnit === 'KM';
  const counter = esKm ? equipo.currentMileage : equipo.currentHourmeter;
  const base: Pick<
    MaintenanceBoardRow,
    | 'equipmentId'
    | 'internalCode'
    | 'type'
    | 'brand'
    | 'model'
    | 'equipmentClass'
    | 'unit'
    | 'status'
    | 'counter'
  > = {
    equipmentId: equipo.id,
    internalCode: equipo.internalCode,
    type: equipo.type,
    brand: equipo.brand || null,
    model: equipo.model || null,
    equipmentClass: equipo.equipmentClass === 'LIGHT' ? 'LIGHT' : 'HEAVY',
    unit: esKm ? 'km' : 'h',
    status: equipo.status,
    counter,
  };

  if (plan) {
    const status = computeMaintenanceStatus(
      {
        milestones: plan.milestones,
        initialMilestone: plan.initialMilestone,
        items: plan.items,
      },
      counter,
      input.planAnchor,
    );
    const next = status.next;
    return {
      ...base,
      source: 'PAUTA',
      milestones: [...plan.milestones].sort((a, b) => a - b),
      initialMilestone: plan.initialMilestone,
      lastChange: lastChangeDe(status.anchor),
      interval: next?.interval ?? null,
      nextMilestone: next?.milestone ?? null,
      dueAt: next?.dueAt ?? null,
      remaining: next?.remaining ?? null,
      alertBefore: plan.alertBefore,
      estimated: status.estimated,
      items: next?.items ?? [],
    };
  }

  if (equipo.equipmentClass === 'LIGHT' && esKm) {
    const liviano = nextLightService(
      counter,
      LIGHT_SERVICE_INTERVAL_KM,
      undefined,
      input.lightAnchor?.counterAt ?? null,
    );
    return {
      ...base,
      source: 'LIVIANO',
      milestones: [],
      initialMilestone: null,
      lastChange: lastChangeDe(input.lightAnchor),
      interval: LIGHT_SERVICE_INTERVAL_KM,
      nextMilestone: LIGHT_SERVICE_INTERVAL_KM,
      dueAt: liviano?.nextKm ?? null,
      remaining: liviano?.remainingKm ?? null,
      alertBefore: input.lightAlertKm ?? LIGHT_SERVICE_ALERT_KM,
      estimated: input.lightAnchor == null,
      items: [],
    };
  }

  return {
    ...base,
    source: 'SIN_PAUTA',
    milestones: [],
    initialMilestone: null,
    lastChange: null,
    interval: null,
    nextMilestone: null,
    dueAt: null,
    remaining: null,
    alertBefore: null,
    estimated: false,
    items: [],
  };
}
