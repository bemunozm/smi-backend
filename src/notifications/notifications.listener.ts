/**
 * Escucha los 4 eventos de dominio (`common/events/domain-events.ts`) y los
 * traduce a notificaciones vía `NotificationsService`. Los dominios que
 * disparan estos eventos (Terreno/Mantenimiento/Inventario) se conectan en
 * una fase posterior — este listener ya queda listo para recibirlos.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  DOMAIN_EVENTS,
  type HallazgoCreatedEvent,
  type InsumoLowStockEvent,
  type OrdenAssignedEvent,
  type OrdenCompletedEvent,
} from '../common/events/domain-events';
import { NotificationsService } from './notifications.service';
import {
  HALLAZGO_CREATED_ROLES,
  INSUMO_LOW_STOCK_ROLES,
  ORDEN_ASSIGNED_ROLES,
  ORDEN_COMPLETED_ROLES,
  buildHallazgoCreatedTemplate,
  buildInsumoLowStockTemplate,
  buildOrdenAssignedTemplate,
  buildOrdenCompletedTemplate,
} from './notifications.constants';

@Injectable()
export class NotificationsListener {
  private readonly logger = new Logger(NotificationsListener.name);

  constructor(private readonly notifications: NotificationsService) {}

  @OnEvent(DOMAIN_EVENTS.HALLAZGO_CREATED)
  async onHallazgoCreated(event: HallazgoCreatedEvent): Promise<void> {
    const template = buildHallazgoCreatedTemplate(event);
    await this.notifications.createForRoles(HALLAZGO_CREATED_ROLES, {
      ...template,
      data: { hallazgoId: event.hallazgoId, equipoId: event.equipoId ?? null },
    });
  }

  @OnEvent(DOMAIN_EVENTS.ORDEN_ASSIGNED)
  async onOrdenAssigned(event: OrdenAssignedEvent): Promise<void> {
    const template = buildOrdenAssignedTemplate(event);
    // OrdenTrabajo.equipoId es soft-ref: la UI de creación de OT puede haber
    // guardado el código del equipo en vez del id — se resuelve a un id real
    // antes de propagarlo en `data` para no romper la navegación del front.
    const equipoId = await this.notifications.resolveEquipoId(event.equipoId);
    const data = { ordenId: event.ordenId, equipoId };

    if (event.asignadoId) {
      await this.notifications.createForUser(event.asignadoId, {
        ...template,
        data,
      });
    } else {
      this.logger.debug(
        `orden.assigned sin asignadoId (ordenId="${event.ordenId}"), solo se notifica a SUPERVISOR`,
      );
    }

    await this.notifications.createForRoles(ORDEN_ASSIGNED_ROLES, {
      ...template,
      data,
    });
  }

  @OnEvent(DOMAIN_EVENTS.ORDEN_COMPLETED)
  async onOrdenCompleted(event: OrdenCompletedEvent): Promise<void> {
    const template = buildOrdenCompletedTemplate(event);
    // Ver comentario en `onOrdenAssigned`: mismo soft-ref, misma resolución.
    const equipoId = await this.notifications.resolveEquipoId(event.equipoId);
    await this.notifications.createForRoles(ORDEN_COMPLETED_ROLES, {
      ...template,
      data: { ordenId: event.ordenId, equipoId },
    });
  }

  @OnEvent(DOMAIN_EVENTS.INSUMO_LOW_STOCK)
  async onInsumoLowStock(event: InsumoLowStockEvent): Promise<void> {
    const template = buildInsumoLowStockTemplate(event);
    await this.notifications.createForRoles(INSUMO_LOW_STOCK_ROLES, {
      ...template,
      data: {
        insumoId: event.insumoId,
        stock: event.stock,
        stockMinimo: event.stockMinimo,
      },
    });
  }
}
