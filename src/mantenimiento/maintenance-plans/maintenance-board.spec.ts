import { buildBoardRow, type BoardEquipment } from './maintenance-board';
import type { MaintenanceAnchor } from './maintenance-plan-status';

const heavy: BoardEquipment = {
  id: 'e1',
  internalCode: 'BD-005',
  type: 'Bulldozer',
  brand: 'CAT',
  model: 'D6',
  equipmentClass: 'HEAVY',
  controlUnit: 'HOURS',
  status: 'OPERATIONAL',
  currentHourmeter: 2600,
  currentMileage: null,
};
const light: BoardEquipment = {
  ...heavy,
  id: 'e2',
  internalCode: 'LV-001',
  type: 'Camioneta',
  equipmentClass: 'LIGHT',
  controlUnit: 'KM',
  currentHourmeter: null,
  currentMileage: 24000,
};
const item = {
  id: 'i1',
  kind: 'FILTRO',
  description: 'Filtro aceite',
  quantity: 1,
  unit: null,
  partNumber: null,
  inventoryItemId: null,
  milestones: [250, 500],
};
const plan = {
  milestones: [250, 500],
  initialMilestone: null,
  alertBefore: 20,
  items: [item],
};
const anchor = (milestone: number, counterAt: number): MaintenanceAnchor => ({
  milestone,
  cycle: 1,
  counterAt,
  doneAt: new Date('2026-10-01T12:00:00.000Z'),
});

describe('buildBoardRow', () => {
  it('PAUTA con ancla: cuenta desde el último cambio', () => {
    const row = buildBoardRow({
      equipo: heavy,
      plan,
      planAnchor: anchor(250, 2480),
      lightAnchor: null,
      lightAlertKm: null,
    });
    expect(row).toMatchObject({
      source: 'PAUTA',
      unit: 'h',
      counter: 2600,
      milestones: [250, 500],
      lastChange: {
        milestone: 250,
        counterAt: 2480,
        doneAt: '2026-10-01T12:00:00.000Z',
      },
      nextMilestone: 500,
      dueAt: 2730,
      remaining: 130,
      interval: 250,
      alertBefore: 20,
      estimated: false,
    });
    expect(row.items).toEqual([item]);
  });

  it('PAUTA sin ancla: estimada y sin último cambio', () => {
    const row = buildBoardRow({
      equipo: heavy,
      plan,
      planAnchor: null,
      lightAnchor: null,
      lightAlertKm: null,
    });
    expect(row.source).toBe('PAUTA');
    expect(row.estimated).toBe(true);
    expect(row.lastChange).toBeNull();
    expect(row.dueAt).toBe(2750);
  });

  it('LIVIANO con ancla: toca 10.000 km después', () => {
    const row = buildBoardRow({
      equipo: light,
      plan: null,
      planAnchor: null,
      lightAnchor: anchor(10000, 20500),
      lightAlertKm: 1500,
    });
    expect(row).toMatchObject({
      source: 'LIVIANO',
      unit: 'km',
      interval: 10000,
      nextMilestone: 10000,
      dueAt: 30500,
      remaining: 6500,
      alertBefore: 1500,
      estimated: false,
      milestones: [],
      items: [],
      lastChange: { milestone: 10000, counterAt: 20500 },
    });
  });

  it('LIVIANO sin configuración usa el aviso de defecto', () => {
    const row = buildBoardRow({
      equipo: light,
      plan: null,
      planAnchor: null,
      lightAnchor: null,
      lightAlertKm: null,
    });
    expect(row.alertBefore).toBe(1000);
    expect(row.estimated).toBe(true);
    expect(row.dueAt).toBe(30000);
  });

  it('SIN_PAUTA pesado: todo nulo', () => {
    const row = buildBoardRow({
      equipo: heavy,
      plan: null,
      planAnchor: null,
      lightAnchor: null,
      lightAlertKm: null,
    });
    expect(row).toMatchObject({
      source: 'SIN_PAUTA',
      lastChange: null,
      interval: null,
      nextMilestone: null,
      dueAt: null,
      remaining: null,
      alertBefore: null,
      estimated: false,
      items: [],
    });
  });

  it('sin contador: no calcula y no falla', () => {
    const sinLectura = { ...heavy, currentHourmeter: null };
    const pauta = buildBoardRow({
      equipo: sinLectura,
      plan,
      planAnchor: anchor(250, 2480),
      lightAnchor: null,
      lightAlertKm: null,
    });
    expect(pauta.counter).toBeNull();
    expect(pauta.dueAt).toBeNull();
    expect(pauta.remaining).toBeNull();
    const liviano = buildBoardRow({
      equipo: { ...light, currentMileage: null },
      plan: null,
      planAnchor: null,
      lightAnchor: null,
      lightAlertKm: null,
    });
    expect(liviano.dueAt).toBeNull();
    expect(liviano.remaining).toBeNull();
  });
});
