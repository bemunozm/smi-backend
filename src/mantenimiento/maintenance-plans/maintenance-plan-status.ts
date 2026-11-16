/**
 * En qué punto de su pauta va un equipo y cuál es su próxima mantención.
 *
 * Es una función pura —sin base de datos— porque la regla la usan tres lados
 * (la ventana de la pauta, la tabla de Equipos y las tareas preventivas del
 * mantenedor) y tiene que dar lo mismo en los tres.
 *
 * La regla del cliente: la próxima mantención se cuenta desde el último cambio
 * real (el «ancla»). Si el último fue la de 500 h hecha a las 2.480 h, la
 * siguiente es la de 750 a las 2.730 h, diga lo que diga el horómetro total.
 * Tras el hito más alto (el largo del ciclo) viene el primero de la vuelta
 * siguiente.
 *
 * Sin ancla —el equipo nunca registró una mantención— se usa la regla anterior
 * como respaldo, para que alertas y órdenes sigan funcionando: los hitos se
 * cuentan sobre el contador del equipo y al llegar al largo del ciclo vuelve a
 * cero (con hitos hasta 2.000 h, un equipo con 2.250 h está en las 250 del
 * ciclo y su próxima es la de 500). Ese valor se marca como estimado.
 */
import { currentCycle } from './maintenance-cycle';

export interface PlanItemForStatus {
  id: string;
  kind: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  partNumber: string | null;
  inventoryItemId: string | null;
  milestones: number[];
}

export interface PlanForStatus {
  milestones: number[];
  initialMilestone: number | null;
  items: PlanItemForStatus[];
}

export interface NextMaintenance {
  /** El hito que toca: 250, 500… o el servicio inicial. */
  milestone: number;
  /** Es el servicio que se hace una sola vez al comenzar (no se repite). */
  firstTimeOnly: boolean;
  /**
   * Cuánto falta, en horas o km. 0 = toca ahora. Con ancla puede ser negativo:
   * la mantención está atrasada por esa cantidad.
   */
  remaining: number;
  /** El contador absoluto en que toca (2.250, no 250). */
  dueAt: number;
  /** La vuelta del ciclo a la que pertenece este hito (desde 1). */
  cycle: number;
  /** Horas o km desde el hito anterior hasta este: las «horas cambio» de la pizarra. */
  interval: number;
  /** Lo que hay que hacer en ese hito, en el orden de la pauta. */
  items: PlanItemForStatus[];
}

/** El último cambio real del equipo, desde el que se cuenta la próxima mantención. */
export interface MaintenanceAnchor {
  /** El hito que se hizo: 500, 1.000… o el servicio inicial. */
  milestone: number;
  /** La vuelta del ciclo en que se hizo. */
  cycle: number;
  /** El contador del equipo al hacerlo. */
  counterAt: number;
  doneAt: Date;
}

export interface MaintenanceStatus {
  counter: number | null;
  cycleLength: number | null;
  positionInCycle: number | null;
  next: NextMaintenance | null;
  anchor: MaintenanceAnchor | null;
  /** Sin ancla: la próxima sale de los hitos absolutos, no de un cambio real. */
  estimated: boolean;
  /**
   * Contador en que empieza la vuelta del próximo hito (su hito 0). Con ancla
   * es el horómetro del cambio menos su hito; sin ella, un múltiplo del ciclo.
   */
  cycleOrigin: number | null;
}

/** Redondea a una décima, que es lo que marca un horómetro. */
const decima = (n: number) => Math.round(n * 10) / 10;

export function computeMaintenanceStatus(
  plan: PlanForStatus | null,
  counter: number | null,
  anchor: MaintenanceAnchor | null = null,
): MaintenanceStatus {
  const milestones = [...(plan?.milestones ?? [])].sort((a, b) => a - b);
  const cycleLength = milestones.length
    ? milestones[milestones.length - 1]
    : null;
  const vacio: MaintenanceStatus = {
    counter,
    cycleLength,
    positionInCycle: null,
    next: null,
    anchor,
    estimated: anchor == null,
    cycleOrigin: null,
  };
  if (!plan || counter == null || counter < 0) return vacio;

  const itemsDe = (hito: number) =>
    plan.items.filter((i) => i.milestones.includes(hito));

  if (anchor && cycleLength != null) {
    return {
      ...vacio,
      positionInCycle: decima(counter % cycleLength),
      ...desdeElAncla(plan, milestones, counter, anchor, itemsDe),
    };
  }

  // El servicio inicial va primero mientras el equipo no lo haya pasado.
  const inicial = plan.initialMilestone;
  if (inicial != null && counter < inicial) {
    return {
      ...vacio,
      positionInCycle: decima(counter),
      cycleOrigin: 0,
      next: {
        milestone: inicial,
        firstTimeOnly: true,
        remaining: decima(inicial - counter),
        dueAt: inicial,
        cycle: 1,
        interval: inicial,
        items: itemsDe(inicial),
      },
    };
  }

  if (cycleLength == null) return vacio;

  // Lo que el respaldo agrega para la pizarra: la vuelta sale del contador en
  // que toca y el intervalo es la distancia al hito anterior de la secuencia
  // (la primera de la vuelta 1 se cuenta desde el servicio inicial).
  const vueltaDe = (hito: number, dueAt: number) => {
    const cycle = currentCycle(dueAt, cycleLength);
    const i = milestones.indexOf(hito);
    const anterior =
      i > 0 ? milestones[i - 1] : cycle === 1 && inicial != null ? inicial : 0;
    return {
      cycle,
      interval: decima(hito - anterior),
      cycleOrigin: (cycle - 1) * cycleLength,
    };
  };

  const posicion = decima(counter % cycleLength);

  // Justo en el fin del ciclo (2.000, 4.000…): toca la mantención mayor ahora,
  // no la primera del ciclo siguiente.
  if (posicion === 0 && counter > 0) {
    const dueAt = decima(counter);
    const { cycle, interval, cycleOrigin } = vueltaDe(cycleLength, dueAt);
    return {
      ...vacio,
      positionInCycle: 0,
      cycleOrigin,
      next: {
        milestone: cycleLength,
        firstTimeOnly: false,
        remaining: 0,
        dueAt,
        cycle,
        interval,
        items: itemsDe(cycleLength),
      },
    };
  }

  // Siempre hay uno: el último hito es el largo del ciclo y la posición es menor.
  const hito = milestones.find((m) => m > posicion)!;
  const remaining = decima(hito - posicion);
  const dueAt = decima(counter + remaining);
  const { cycle, interval, cycleOrigin } = vueltaDe(hito, dueAt);
  return {
    ...vacio,
    positionInCycle: posicion,
    cycleOrigin,
    next: {
      milestone: hito,
      firstTimeOnly: false,
      remaining,
      dueAt,
      cycle,
      interval,
      items: itemsDe(hito),
    },
  };
}

/**
 * La próxima mantención contada desde el último cambio real: el hito que sigue
 * al del ancla, a su intervalo del contador en que se hizo. `milestones` viene
 * ordenado y no vacío.
 */
function desdeElAncla(
  plan: PlanForStatus,
  milestones: number[],
  counter: number,
  anchor: MaintenanceAnchor,
  itemsDe: (hito: number) => PlanItemForStatus[],
): Pick<MaintenanceStatus, 'next' | 'estimated' | 'cycleOrigin'> {
  const { milestone: hecho, cycle: vuelta, counterAt } = anchor;
  const largo = milestones[milestones.length - 1];
  // Donde empezó la vuelta del ancla: el horómetro del cambio menos su hito.
  const origen = counterAt - hecho;

  let hito = milestones[0];
  let cycle = vuelta;
  let interval = hito - hecho;
  let cycleOrigin = origen;
  if (!(hecho === plan.initialMilestone && vuelta === 1)) {
    // Si la pauta se editó y el hito del ancla ya no está, se toma el mayor
    // que quedó por debajo: el equipo ya pasó por él. Sin ninguno (-1), sigue
    // el primero de la misma vuelta, como tras el servicio inicial.
    let i = milestones.indexOf(hecho);
    if (i === -1) i = milestones.filter((m) => m < hecho).length - 1;
    if (i === milestones.length - 1) {
      // Fin de ciclo: la primera de la vuelta siguiente, que empieza aquí.
      cycle = vuelta + 1;
      interval = hito;
      cycleOrigin = origen + largo;
    } else if (i >= 0) {
      hito = milestones[i + 1];
      interval = hito - hecho;
    }
  }

  const dueAt = decima(counterAt + interval);
  return {
    estimated: false,
    cycleOrigin: decima(cycleOrigin),
    next: {
      milestone: hito,
      firstTimeOnly: false,
      remaining: decima(dueAt - counter),
      dueAt,
      cycle,
      interval: decima(interval),
      items: itemsDe(hito),
    },
  };
}
