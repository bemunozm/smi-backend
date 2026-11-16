import {
  computeMaintenanceStatus,
  type PlanForStatus,
} from './maintenance-plan-status';

/** La pauta del ejemplo del cliente: hitos hasta 2.000 h. */
const item = (id: string, milestones: number[]) => ({
  id,
  kind: 'FILTRO',
  description: `Operación ${id}`,
  quantity: 1,
  unit: null,
  partNumber: null,
  inventoryItemId: null,
  milestones,
});

const PAUTA: PlanForStatus = {
  milestones: [250, 500, 750, 1000, 1500, 2000],
  initialMilestone: null,
  items: [
    item('aceite', [250, 500, 750, 1000, 1500, 2000]),
    item('transmision', [1000, 2000]),
    item('correa', [2000]),
  ],
};

describe('computeMaintenanceStatus', () => {
  it('a las 2.100 h va en las 100 del ciclo y la próxima es la de 250', () => {
    const s = computeMaintenanceStatus(PAUTA, 2100);

    expect(s.cycleLength).toBe(2000);
    expect(s.positionInCycle).toBe(100);
    expect(s.next).toMatchObject({
      milestone: 250,
      remaining: 150,
      dueAt: 2250,
    });
  });

  /** El ejemplo del cliente: 2.250 cuenta como 250. */
  it('a las 2.250 h el ciclo reinició: está en la de 250 y la próxima es la de 500', () => {
    const s = computeMaintenanceStatus(PAUTA, 2250);

    expect(s.positionInCycle).toBe(250);
    expect(s.next).toMatchObject({ milestone: 500, remaining: 250 });
  });

  it('justo en el fin del ciclo toca la mantención mayor ahora', () => {
    const s = computeMaintenanceStatus(PAUTA, 4000);

    expect(s.next).toMatchObject({
      milestone: 2000,
      remaining: 0,
      dueAt: 4000,
    });
    expect(s.next?.items.map((i) => i.id)).toEqual([
      'aceite',
      'transmision',
      'correa',
    ]);
  });

  /** Cada hito tiene su propia lista: no se acumulan las de los anteriores. */
  it('trae solo las operaciones marcadas en ese hito', () => {
    const s = computeMaintenanceStatus(PAUTA, 800);

    expect(s.next?.milestone).toBe(1000);
    expect(s.next?.items.map((i) => i.id)).toEqual(['aceite', 'transmision']);
  });

  it('un equipo nuevo hace primero el servicio inicial, una sola vez', () => {
    const conInicial: PlanForStatus = {
      ...PAUTA,
      initialMilestone: 50,
      items: [...PAUTA.items, item('rodaje', [50])],
    };

    expect(computeMaintenanceStatus(conInicial, 20).next).toMatchObject({
      milestone: 50,
      firstTimeOnly: true,
      remaining: 30,
    });
    // Pasado el inicial, sigue el ciclo normal y no vuelve a aparecer.
    expect(computeMaintenanceStatus(conInicial, 2030).next).toMatchObject({
      milestone: 250,
      firstTimeOnly: false,
    });
  });

  it('respeta las décimas del horómetro', () => {
    expect(computeMaintenanceStatus(PAUTA, 2487.3).next).toMatchObject({
      milestone: 500,
      remaining: 12.7,
    });
  });

  it('sin pauta o sin contador no hay próxima mantención', () => {
    expect(computeMaintenanceStatus(null, 2100).next).toBeNull();
    expect(computeMaintenanceStatus(PAUTA, null).next).toBeNull();
    expect(
      computeMaintenanceStatus({ ...PAUTA, milestones: [] }, 2100).next,
    ).toBeNull();
  });
});

describe('computeMaintenanceStatus con ancla (desde el último cambio real)', () => {
  const CON_ANCLA: PlanForStatus = {
    milestones: [250, 500, 750, 1000],
    initialMilestone: 50,
    items: [
      item('rodaje', [50]),
      item('h250', [250]),
      item('h500', [500]),
      item('h750', [750]),
      item('h1000', [1000]),
    ],
  };
  const ancla = (milestone: number, cycle: number, counterAt: number) => ({
    milestone,
    cycle,
    counterAt,
    doneAt: new Date('2026-11-01T12:00:00Z'),
  });

  it('anclado a mitad de ciclo: cuenta desde el horómetro del último cambio', () => {
    const s = computeMaintenanceStatus(CON_ANCLA, 2_600, ancla(500, 3, 2_480));

    expect(s.next).toMatchObject({
      milestone: 750,
      cycle: 3,
      interval: 250,
      dueAt: 2_730,
      remaining: 130,
    });
    expect(s.next?.items.map((i) => i.id)).toEqual(['h750']);
    expect(s.estimated).toBe(false);
    expect(s.cycleOrigin).toBe(1_980);
  });

  it('anclado en el fin de ciclo pasa a la primera de la vuelta siguiente', () => {
    const s = computeMaintenanceStatus(CON_ANCLA, 2_100, ancla(1000, 2, 2_030));

    expect(s.next).toMatchObject({
      milestone: 250,
      cycle: 3,
      interval: 250,
      dueAt: 2_280,
    });
    expect(s.cycleOrigin).toBe(2_030);
  });

  it('anclado en el servicio inicial sigue la primera de la vuelta 1', () => {
    const s = computeMaintenanceStatus(CON_ANCLA, 100, ancla(50, 1, 60));

    expect(s.next).toMatchObject({
      milestone: 250,
      cycle: 1,
      interval: 200,
      dueAt: 260,
      firstTimeOnly: false,
    });
    expect(s.cycleOrigin).toBe(10);
  });

  it('atrasado: lo pendiente queda negativo', () => {
    const s = computeMaintenanceStatus(CON_ANCLA, 540, ancla(250, 1, 250));

    expect(s.next).toMatchObject({
      milestone: 500,
      dueAt: 500,
      remaining: -40,
    });
  });

  it('si el hito del ancla ya no está en la pauta, sigue el siguiente mayor', () => {
    const s = computeMaintenanceStatus(CON_ANCLA, 700, ancla(600, 1, 600));

    expect(s.next).toMatchObject({ milestone: 750, interval: 150 });
  });

  it('sin ancla mantiene los hitos absolutos y marca el valor como estimado', () => {
    const s = computeMaintenanceStatus(CON_ANCLA, 2_100);

    expect(s.next).toMatchObject({
      milestone: 250,
      dueAt: 2_250,
      cycle: 3,
      interval: 250,
    });
    expect(s.estimated).toBe(true);
    expect(s.anchor).toBeNull();
    expect(s.cycleOrigin).toBe(2_000);
  });

  it('sin ancla, el servicio inicial y la primera tras él tienen su propio intervalo', () => {
    expect(computeMaintenanceStatus(CON_ANCLA, 20).next).toMatchObject({
      milestone: 50,
      cycle: 1,
      interval: 50,
    });
    expect(computeMaintenanceStatus(CON_ANCLA, 100).next).toMatchObject({
      milestone: 250,
      cycle: 1,
      interval: 200,
    });
    expect(computeMaintenanceStatus(CON_ANCLA, 600).next).toMatchObject({
      milestone: 750,
      cycle: 1,
      interval: 250,
    });
  });

  it('sin contador no hay próxima, pero el ancla se informa igual', () => {
    const a = ancla(500, 3, 2_480);
    const s = computeMaintenanceStatus(CON_ANCLA, null, a);

    expect(s.next).toBeNull();
    expect(s.anchor).toEqual(a);
    expect(s.estimated).toBe(false);
  });
});
