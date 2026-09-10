/**
 * Mapa evento de dominio → plantilla de notificación (título/cuerpo) + roles
 * destino. Un solo lugar para que agregar/editar el texto de una
 * notificación no obligue a tocar `notifications.listener.ts`.
 */
import { ROLES } from '../auth/roles';
import type { Role } from '../auth/roles';
import type {
  HallazgoCreatedEvent,
  ItemLowStockEvent,
  OrdenAssignedEvent,
  OrdenCompletedEvent,
} from '../common/events/domain-events';
import { DOMAIN_EVENTS } from '../common/events/domain-events';

export interface NotificationTemplate {
  tipo: string;
  titulo: string;
  cuerpo: string;
}

/** `hallazgo.created` → SUPERVISOR + ADMIN (requerimientos §5.1). */
export const HALLAZGO_CREATED_ROLES: readonly Role[] = [
  ROLES.SUPERVISOR,
  ROLES.ADMIN,
];

export function buildHallazgoCreatedTemplate(
  event: HallazgoCreatedEvent,
): NotificationTemplate {
  return {
    tipo: DOMAIN_EVENTS.HALLAZGO_CREATED,
    titulo: `Nuevo hallazgo (${event.prioridad})`,
    cuerpo: event.descripcion,
  };
}

/**
 * `orden.assigned` → el `asignadoId` (si viene) recibe `createForUser` +
 * SUPERVISOR recibe `createForRoles`. Ver `notifications.listener.ts`.
 */
export const ORDEN_ASSIGNED_ROLES: readonly Role[] = [ROLES.SUPERVISOR];

export function buildOrdenAssignedTemplate(
  event: OrdenAssignedEvent,
): NotificationTemplate {
  return {
    tipo: DOMAIN_EVENTS.ORDEN_ASSIGNED,
    titulo: 'Orden de trabajo asignada',
    cuerpo: `Se te asignó la orden "${event.titulo}"`,
  };
}

/** `orden.completed` → SUPERVISOR + ADMIN. */
export const ORDEN_COMPLETED_ROLES: readonly Role[] = [
  ROLES.SUPERVISOR,
  ROLES.ADMIN,
];

export function buildOrdenCompletedTemplate(
  event: OrdenCompletedEvent,
): NotificationTemplate {
  return {
    tipo: DOMAIN_EVENTS.ORDEN_COMPLETED,
    titulo: 'Orden de trabajo completada',
    cuerpo: `La orden "${event.titulo}" fue completada`,
  };
}

/** `insumo.low-stock` → ADMIN + SUPERVISOR. */
export const ITEM_LOW_STOCK_ROLES: readonly Role[] = [
  ROLES.ADMIN,
  ROLES.SUPERVISOR,
];

export function buildItemLowStockTemplate(
  event: ItemLowStockEvent,
): NotificationTemplate {
  return {
    tipo: DOMAIN_EVENTS.ITEM_LOW_STOCK,
    titulo: `Stock bajo: ${event.itemName}`,
    // La bodega va en el cuerpo porque es lo que vuelve accionable el aviso:
    // sin ella, quien lo lee no sabe si le toca a él reponer.
    cuerpo: `Quedan ${event.quantity} en ${event.branchName} (mínimo ${event.minimumQuantity})`,
  };
}
