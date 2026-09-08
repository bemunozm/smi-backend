/**
 * Contrato de eventos de dominio (Núcleo). Cada dominio (Terreno,
 * Mantenimiento, Inventario) emite estos eventos vía `EventEmitter2.emit(...)`
 * cuando corresponda — eso es una fase posterior de esta feature, NO se toca
 * aquí. Este archivo solo define el contrato compartido: nombre de evento +
 * shape del payload, para que `NotificationsModule` (el único consumidor por
 * ahora) pueda escucharlos con `@OnEvent(...)` de forma tipada.
 *
 * Los payloads son deliberadamente livianos (ids + los campos mínimos para
 * armar un título/cuerpo de notificación) — si el listener necesita más
 * datos, se resuelven por su cuenta vía `PrismaService`, no infladando el
 * evento.
 */

export const DOMAIN_EVENTS = {
  HALLAZGO_CREATED: 'hallazgo.created',
  ORDEN_ASSIGNED: 'orden.assigned',
  ORDEN_COMPLETED: 'orden.completed',
  INSUMO_LOW_STOCK: 'insumo.low-stock',
} as const;

export type DomainEventName =
  (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

/** Emitido por Terreno (Alexander) al crear un Hallazgo. */
export interface HallazgoCreatedEvent {
  hallazgoId: string;
  equipoId?: string | null;
  prioridad: string;
  descripcion: string;
}

/** Emitido por Mantenimiento (Joaquín) al asignar una Orden de Trabajo. */
export interface OrdenAssignedEvent {
  ordenId: string;
  equipoId?: string | null;
  asignadoId?: string | null;
  titulo: string;
}

/** Emitido por Mantenimiento (Joaquín) al completar una Orden de Trabajo. */
export interface OrdenCompletedEvent {
  ordenId: string;
  equipoId?: string | null;
  titulo: string;
}

/** Emitido por Inventario (Amin) cuando un Insumo cruza su stockMinimo. */
export interface InsumoLowStockEvent {
  insumoId: string;
  nombre: string;
  stock: number;
  stockMinimo: number;
}
