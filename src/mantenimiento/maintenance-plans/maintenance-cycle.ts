/**
 * Ciclo de mantenciones de un equipo: qué se hizo de su pauta en cada vuelta.
 *
 * Funciones puras, sin base de datos, para que la regla se pruebe sola y la
 * usen igual la ficha del equipo y, más adelante, las tareas del mantenedor.
 *
 * Las vueltas se cuentan desde 1 sobre el contador del equipo (horómetro o
 * km). Con un ciclo de 2.000 h: el ciclo 1 va de 0 a 2.000 h, el 2 de 2.000 a
 * 4.000. Justo en 2.000 h el equipo todavía está cerrando el ciclo 1 —le toca
 * la mantención de 2.000—, igual que en `computeMaintenanceStatus`.
 */

export interface CycleItem {
  id: string;
  milestones: number[];
}

export interface CycleRecord {
  planItemId: string | null;
  milestone: number;
}

export interface CycleColumn {
  /** El hito dentro del ciclo: 250, 500… */
  milestone: number;
  /** Servicio inicial: solo existe en el ciclo 1. */
  firstTimeOnly: boolean;
  /** Contador absoluto en que toca: 2.250 para el hito 250 del ciclo 2. */
  dueAt: number;
  /** El equipo ya llegó a ese contador. */
  reached: boolean;
  /** Operaciones de la pauta que se hacen en este hito. */
  total: number;
  done: number;
  /** Todas sus operaciones están hechas: la columna se pinta en verde. */
  complete: boolean;
  /**
   * Vencía antes de que el equipo entrara al sistema (`baselineCounter`): se
   * da por hecha. Se muestra completa y no se marca ni se desmarca.
   */
  preSystem: boolean;
  /**
   * Se puede marcar: todos los hitos anteriores de la vuelta están completos.
   * Las mantenciones se hacen en orden — no se registra la de 500 h con la de
   * 250 h a medias.
   */
  unlocked: boolean;
  /**
   * Se puede desmarcar: ningún hito posterior tiene operaciones registradas.
   * Quitar una de 250 h con la de 500 h ya hecha rompería el orden.
   */
  canUndo: boolean;
}

/** Un hito sin operaciones en la pauta no frena a los siguientes: no hay nada que hacer en él. */
const cerrado = (c: Pick<CycleColumn, 'total' | 'complete'>) =>
  c.total === 0 || c.complete;

/** En qué vuelta del ciclo va el equipo. Sin contador, o en 0, es la primera. */
export function currentCycle(
  counter: number | null,
  cycleLength: number,
): number {
  if (counter == null || counter <= 0 || cycleLength <= 0) return 1;
  return Math.ceil(counter / cycleLength);
}

/**
 * Las columnas de una vuelta del ciclo, en orden, con su avance. Una columna
 * sin operaciones en la pauta no cuenta como completa: no hay nada hecho que
 * mostrar en verde.
 */
export function cycleColumns(params: {
  milestones: number[];
  initialMilestone: number | null;
  items: CycleItem[];
  records: CycleRecord[];
  cycle: number;
  counter: number | null;
  /** Contador con que el equipo entró al sistema; ver `MaintenancePlan.baselineCounter`. */
  baselineCounter?: number | null;
}): CycleColumn[] {
  const { initialMilestone, items, records, cycle, counter } = params;
  const baseline = params.baselineCounter ?? null;
  const milestones = [...params.milestones].sort((a, b) => a - b);
  const cycleLength = milestones[milestones.length - 1] ?? 0;
  const base = (cycle - 1) * cycleLength;

  const hechas = new Set(records.map((r) => `${r.planItemId}|${r.milestone}`));
  const columna = (
    milestone: number,
    firstTimeOnly: boolean,
  ): Omit<CycleColumn, 'unlocked' | 'canUndo'> => {
    const dueAt = firstTimeOnly ? milestone : base + milestone;
    const aplican = items.filter((i) => i.milestones.includes(milestone));
    // Lo que vencía antes de entrar al sistema ya se hizo fuera de él: un
    // equipo que llega con 2.100 h pasó todas las del ciclo de 2.000 h. Se usa
    // `<` y no `<=`: la que vence justo al entrar todavía hay que registrarla.
    const preSystem = baseline != null && dueAt < baseline;
    const done = preSystem
      ? aplican.length
      : aplican.filter((i) => hechas.has(`${i.id}|${milestone}`)).length;
    return {
      milestone,
      firstTimeOnly,
      dueAt,
      reached: counter != null && counter >= dueAt,
      total: aplican.length,
      done,
      complete: preSystem || (aplican.length > 0 && done === aplican.length),
      preSystem,
    };
  };

  const columnas = [
    ...(cycle === 1 && initialMilestone != null
      ? [columna(initialMilestone, true)]
      : []),
    ...milestones.map((m) => columna(m, false)),
  ];
  return columnas.map((c, i) => ({
    ...c,
    unlocked: columnas.slice(0, i).every(cerrado),
    canUndo: !c.preSystem && columnas.slice(i + 1).every((p) => p.done === 0),
  }));
}
