import { currentCycle, cycleColumns } from './maintenance-cycle';

const ITEMS = [
  { id: 'aceite', milestones: [250, 500, 2000] },
  { id: 'filtro', milestones: [250, 2000] },
  { id: 'correa', milestones: [2000] },
  { id: 'rodaje', milestones: [50] },
];

describe('currentCycle', () => {
  it('cuenta las vueltas desde 1 y en el borde todavía cierra la anterior', () => {
    expect(currentCycle(null, 2000)).toBe(1);
    expect(currentCycle(0, 2000)).toBe(1);
    expect(currentCycle(1999, 2000)).toBe(1);
    expect(currentCycle(2000, 2000)).toBe(1);
    expect(currentCycle(2100, 2000)).toBe(2);
    expect(currentCycle(4001, 2000)).toBe(3);
  });
});

describe('cycleColumns', () => {
  const base = {
    milestones: [500, 250, 2000],
    initialMilestone: 50,
    items: ITEMS,
    records: [],
    counter: 2100,
  };

  it('el ciclo 1 incluye el servicio inicial; los siguientes no', () => {
    expect(cycleColumns({ ...base, cycle: 1 }).map((c) => c.milestone)).toEqual(
      [50, 250, 500, 2000],
    );
    expect(cycleColumns({ ...base, cycle: 2 }).map((c) => c.milestone)).toEqual(
      [250, 500, 2000],
    );
  });

  it('calcula en qué contador toca cada hito de la vuelta', () => {
    const [h250] = cycleColumns({ ...base, cycle: 2 });
    expect(h250).toMatchObject({ milestone: 250, dueAt: 2250, reached: false });
    const [, , h2000] = cycleColumns({ ...base, cycle: 1 }).slice(1);
    expect(h2000).toMatchObject({ dueAt: 2000, reached: true });
  });

  /** La columna se pinta en verde solo cuando TODAS sus operaciones están hechas. */
  it('una columna está completa solo con todas sus operaciones hechas', () => {
    const parcial = cycleColumns({
      ...base,
      cycle: 1,
      records: [{ planItemId: 'aceite', milestone: 250 }],
    }).find((c) => c.milestone === 250);
    expect(parcial).toMatchObject({ total: 2, done: 1, complete: false });

    const completa = cycleColumns({
      ...base,
      cycle: 1,
      records: [
        { planItemId: 'aceite', milestone: 250 },
        { planItemId: 'filtro', milestone: 250 },
      ],
    }).find((c) => c.milestone === 250);
    expect(completa).toMatchObject({ total: 2, done: 2, complete: true });
  });

  it('un hito sin operaciones en la pauta no se marca completo', () => {
    const sinOps = cycleColumns({
      ...base,
      milestones: [250, 750, 2000],
      cycle: 1,
    }).find((c) => c.milestone === 750);
    expect(sinOps).toMatchObject({ total: 0, complete: false });
  });
});

describe('orden de los hitos', () => {
  const base = {
    milestones: [250, 500, 2000],
    initialMilestone: null,
    items: [
      { id: 'aceite', milestones: [250, 500, 2000] },
      { id: 'filtro', milestones: [250, 2000] },
    ],
    cycle: 1,
    counter: 2100,
  };

  it('solo el primer hito está habilitado mientras no se complete', () => {
    const [h250, h500, h2000] = cycleColumns({ ...base, records: [] });
    expect([h250.unlocked, h500.unlocked, h2000.unlocked]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('completar un hito habilita el siguiente', () => {
    const [, h500, h2000] = cycleColumns({
      ...base,
      records: [
        { planItemId: 'aceite', milestone: 250 },
        { planItemId: 'filtro', milestone: 250 },
      ],
    });
    expect(h500.unlocked).toBe(true);
    expect(h2000.unlocked).toBe(false);
  });

  it('no se puede desmarcar un hito si uno posterior ya tiene registros', () => {
    const [h250, h500] = cycleColumns({
      ...base,
      records: [
        { planItemId: 'aceite', milestone: 250 },
        { planItemId: 'filtro', milestone: 250 },
        { planItemId: 'aceite', milestone: 500 },
      ],
    });
    expect(h250.canUndo).toBe(false);
    expect(h500.canUndo).toBe(true);
  });

  it('un hito sin operaciones no frena al siguiente', () => {
    const cols = cycleColumns({
      ...base,
      milestones: [250, 750, 2000],
      records: [
        { planItemId: 'aceite', milestone: 250 },
        { planItemId: 'filtro', milestone: 250 },
      ],
    });
    expect(cols.find((c) => c.milestone === 2000)?.unlocked).toBe(true);
  });
});

/**
 * Lo que vencía antes de que el equipo entrara al sistema se da por hecho: un
 * equipo que llega con 2.100 h ya pasó todo el ciclo de 2.000 h.
 */
describe('mantenciones previas al sistema', () => {
  const base = {
    milestones: [250, 500, 2000],
    initialMilestone: 50,
    items: [
      { id: 'aceite', milestones: [250, 500, 2000] },
      { id: 'rodaje', milestones: [50] },
    ],
    records: [],
    counter: 2300,
    baselineCounter: 2100,
  };

  it('el ciclo anterior a la entrada queda completo entero', () => {
    const cols = cycleColumns({ ...base, cycle: 1 });
    expect(cols.every((c) => c.preSystem && c.complete)).toBe(true);
    expect(cols.every((c) => !c.canUndo)).toBe(true);
  });

  it('en el ciclo en curso solo lo que vencía antes de la entrada', () => {
    const [h250, h500] = cycleColumns({
      ...base,
      cycle: 2,
      baselineCounter: 2300,
    });
    // 2.250 < 2.300: ya estaba hecha al entrar; 2.500 no.
    expect(h250).toMatchObject({ preSystem: true, complete: true });
    expect(h500).toMatchObject({
      preSystem: false,
      complete: false,
      unlocked: true,
    });
  });

  it('la que vence justo al entrar todavía hay que registrarla', () => {
    const [h250] = cycleColumns({ ...base, cycle: 2, baselineCounter: 2250 });
    expect(h250.preSystem).toBe(false);
  });

  it('sin contador de entrada no se da nada por hecho', () => {
    const cols = cycleColumns({ ...base, cycle: 1, baselineCounter: null });
    expect(cols.some((c) => c.preSystem)).toBe(false);
  });
});
