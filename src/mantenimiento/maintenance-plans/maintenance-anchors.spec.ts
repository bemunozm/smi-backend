import { loadLightAnchors, loadPlanAnchors } from './maintenance-anchors';

type Fila = {
  equipmentId: string;
  milestone: number;
  cycle: number;
  counterAt: number;
  doneAt: Date;
};
type Orden = Partial<Record<keyof Fila, 'asc' | 'desc'>>;

/**
 * Una base de mentira que ordena como Postgres según el `orderBy` pedido: lo
 * que se prueba es justamente qué orden se le pide.
 */
const baseCon = (filas: Fila[]) => {
  const findMany = jest.fn(({ orderBy }: { orderBy: Orden[] }) => {
    const ordenadas = [...filas].sort((a, b) => {
      for (const criterio of orderBy) {
        const [campo, sentido] = Object.entries(criterio)[0] as [
          keyof Fila,
          'asc' | 'desc',
        ];
        const x = +a[campo];
        const y = +b[campo];
        if (x !== y) return sentido === 'desc' ? y - x : x - y;
      }
      return 0;
    });
    return Promise.resolve(ordenadas);
  });
  return { db: { maintenanceRecord: { findMany } } as never, findMany };
};

const fila = (
  milestone: number,
  cycle: number,
  counterAt: number,
  dia = 1,
): Fila => ({
  equipmentId: 'e1',
  milestone,
  cycle,
  counterAt,
  doneAt: new Date(Date.UTC(2026, 10, dia)),
});

describe('loadPlanAnchors', () => {
  it('marcar en la grilla una operación de una vuelta pasada no mueve el ancla', async () => {
    // La de 500 del ciclo 3 se hizo a las 2.480 h. Hoy, con 2.700 h, se marca
    // en la grilla una de 250 del ciclo 2 que faltaba: queda con el contador
    // de hoy, pero no es el último cambio de la secuencia.
    const { db, findMany } = baseCon([
      fila(500, 3, 2_480, 1),
      fila(250, 2, 2_700, 10),
    ]);

    const anclas = await loadPlanAnchors(db, ['e1']);

    expect(anclas.get('e1')).toMatchObject({
      milestone: 500,
      cycle: 3,
      counterAt: 2_480,
    });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('dentro de la vuelta manda el hito más alto, aunque se haya marcado antes', async () => {
    const { db } = baseCon([fila(1000, 1, 1_010, 1), fila(500, 1, 1_050, 5)]);

    const anclas = await loadPlanAnchors(db, ['e1']);

    expect(anclas.get('e1')).toMatchObject({ milestone: 1000, cycle: 1 });
  });

  it('el servicio inicial va antes del primer hito de la vuelta 1', async () => {
    const { db } = baseCon([fila(250, 1, 260, 3), fila(50, 1, 300, 5)]);

    const anclas = await loadPlanAnchors(db, ['e1']);

    expect(anclas.get('e1')).toMatchObject({ milestone: 250, cycle: 1 });
  });

  it('entre las operaciones de un mismo hito manda la de mayor contador', async () => {
    const { db } = baseCon([fila(500, 2, 2_480, 1), fila(500, 2, 2_490, 2)]);

    const anclas = await loadPlanAnchors(db, ['e1']);

    expect(anclas.get('e1')?.counterAt).toBe(2_490);
  });
});

describe('loadLightAnchors', () => {
  it('manda la vuelta más alta y, en ella, el mayor contador', async () => {
    const { db } = baseCon([
      fila(10_000, 3, 30_100, 1),
      fila(10_000, 2, 30_500, 9),
      fila(10_000, 3, 29_900, 2),
    ]);

    const anclas = await loadLightAnchors(db, ['e1']);

    expect(anclas.get('e1')).toMatchObject({ cycle: 3, counterAt: 30_100 });
  });
});
