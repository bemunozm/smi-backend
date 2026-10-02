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
  RecordEditedEvent,
} from '../common/events/domain-events';
import { DOMAIN_EVENTS } from '../common/events/domain-events';

export interface NotificationTemplate {
  tipo: string;
  titulo: string;
  cuerpo: string;
}

/**
 * `hallazgo.created` → MANTENEDOR + ADMIN.
 *
 * Reemplaza a SUPERVISOR + ADMIN (requerimientos §5.1): en el Acta N.° 004
 * (R11) el cliente pidió que la alerta llegue directo a quienes reparan y al
 * administrador. El supervisor es quien registra el hallazgo en terreno, así
 * que avisarle a él —y a los demás supervisores— no acercaba la falla a nadie
 * que la pueda resolver.
 */
export const HALLAZGO_CREATED_ROLES: readonly Role[] = [
  ROLES.MANTENEDOR,
  ROLES.ADMIN,
];

const PRIORIDAD_HALLAZGO: Record<string, string> = {
  BAJA: 'baja',
  MEDIA: 'media',
  ALTA: 'alta',
  CRITICA: 'crítica',
};

/**
 * El título dice la prioridad y la máquina: es lo que el mantenedor necesita
 * para decidir si sale ahora, y lo que se lee en el asunto del correo sin
 * abrirlo.
 */
export function buildHallazgoCreatedTemplate(
  event: HallazgoCreatedEvent,
): NotificationTemplate {
  const prioridad = PRIORIDAD_HALLAZGO[event.prioridad] ?? event.prioridad;
  const equipo = event.equipoCodigo ? ` en ${event.equipoCodigo}` : '';
  return {
    tipo: DOMAIN_EVENTS.HALLAZGO_CREATED,
    titulo: `Hallazgo de prioridad ${prioridad}${equipo}`,
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

/**
 * `record.edited` → ADMIN (Acta N.° 004, R13): editar un registro enviado no
 * pide autorización, pero el administrador se entera de cada cambio.
 */
export const RECORD_EDITED_ROLES: readonly Role[] = [ROLES.ADMIN];

/**
 * El cuerpo lista cada dato con su antes y su después, una línea por dato:
 * el administrador tiene que poder juzgar el cambio desde el aviso o el
 * correo, sin entrar al sistema a buscar qué había antes.
 */
export function buildRecordEditedTemplate(
  event: RecordEditedEvent,
): NotificationTemplate {
  return {
    tipo: DOMAIN_EVENTS.RECORD_EDITED,
    titulo: `${event.editedBy} modificó el ${event.entityLabel}`,
    cuerpo: event.changes
      .map((c) => `${c.label}: ${c.before} → ${c.after}`)
      .join('\n'),
  };
}
