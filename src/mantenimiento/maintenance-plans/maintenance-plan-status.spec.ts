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
