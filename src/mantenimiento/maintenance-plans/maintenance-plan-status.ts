/**
 * En qué punto de su pauta va un equipo y cuál es su próxima mantención.
 *
 * Es una función pura —sin base de datos— porque la regla la usan tres lados
 * (la ventana de la pauta, la tabla de Equipos y las tareas preventivas del
 * mantenedor) y tiene que dar lo mismo en los tres.
 *
 * La regla del cliente: los hitos se cuentan sobre el contador del equipo
 * (horómetro o km) y el hito más alto es el largo del ciclo. Al llegar a él el
 * contador vuelve a cero: con hitos hasta 2.000 h, un equipo con 2.250 h está
 * en las 250 del ciclo y su próxima mantención es la de 500.
 */

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
  /** Cuánto falta, en horas o km. 0 = toca ahora. */
  remaining: number;
  /** El contador absoluto en que toca (2.250, no 250). */
  dueAt: number;
  /** Lo que hay que hacer en ese hito, en el orden de la pauta. */
  items: PlanItemForStatus[];
}

export interface MaintenanceStatus {
  counter: number | null;
  cycleLength: number | null;
  positionInCycle: number | null;
  next: NextMaintenance | null;
}

/** Redondea a una décima, que es lo que marca un horómetro. */
const decima = (n: number) => Math.round(n * 10) / 10;

export function computeMaintenanceStatus(
  plan: PlanForStatus | null,
  counter: number | null,
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
  };
  if (!plan || counter == null || counter < 0) return vacio;

  const itemsDe = (hito: number) =>
    plan.items.filter((i) => i.milestones.includes(hito));

  // El servicio inicial va primero mientras el equipo no lo haya pasado.
  const inicial = plan.initialMilestone;
  if (inicial != null && counter < inicial) {
    return {
      ...vacio,
      positionInCycle: decima(counter),
      next: {
        milestone: inicial,
        firstTimeOnly: true,
        remaining: decima(inicial - counter),
        dueAt: inicial,
        items: itemsDe(inicial),
      },
    };
  }

  if (cycleLength == null) return vacio;

  const posicion = decima(counter % cycleLength);

  // Justo en el fin del ciclo (2.000, 4.000…): toca la mantención mayor ahora,
  // no la primera del ciclo siguiente.
  if (posicion === 0 && counter > 0) {
    return {
      ...vacio,
      positionInCycle: 0,
      next: {
        milestone: cycleLength,
        firstTimeOnly: false,
        remaining: 0,
        dueAt: decima(counter),
        items: itemsDe(cycleLength),
      },
    };
  }

  // Siempre hay uno: el último hito es el largo del ciclo y la posición es menor.
  const hito = milestones.find((m) => m > posicion)!;
  const remaining = decima(hito - posicion);
  return {
    ...vacio,
    positionInCycle: posicion,
    next: {
      milestone: hito,
      firstTimeOnly: false,
      remaining,
      dueAt: decima(counter + remaining),
      items: itemsDe(hito),
    },
  };
}
