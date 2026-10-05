/**
 * Escucha los eventos de dominio (`common/events/domain-events.ts`) y los
 * traduce a notificaciones vía `NotificationsService`. Los dominios que
 * disparan estos eventos (Terreno/Mantenimiento/Inventario) se conectan en
 * una fase posterior — este listener ya queda listo para recibirlos.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { env } from '../common/config/env';
import {
  DOMAIN_EVENTS,
  type HallazgoCreatedEvent,
  type ItemLowStockEvent,
  type OrdenAssignedEvent,
  type OrdenCompletedEvent,
  type RecordEditedEvent,
  type ShiftExitReportSentEvent,
} from '../common/events/domain-events';
import { MailService } from '../mail/mail.service';
import { ShiftReportsService } from '../shifts/shift-reports.service';
import type { ShiftExitReportEmailStatus } from '../shifts/shift-exit-report-email-status';
import { NotificationsService } from './notifications.service';
import {
  HALLAZGO_CREATED_ROLES,
  ITEM_LOW_STOCK_ROLES,
  ORDEN_ASSIGNED_ROLES,
  ORDEN_COMPLETED_ROLES,
  RECORD_EDITED_ROLES,
  SHIFT_EXIT_REPORT_ROLES,
  buildHallazgoCreatedTemplate,
  buildRecordEditedTemplate,
  buildItemLowStockTemplate,
  buildOrdenAssignedTemplate,
  buildOrdenCompletedTemplate,
  buildShiftExitReportSentTemplate,
} from './notifications.constants';

@Injectable()
export class NotificationsListener {
  private readonly logger = new Logger(NotificationsListener.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly shiftReports: ShiftReportsService,
  ) {}

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

  @OnEvent(DOMAIN_EVENTS.RECORD_EDITED)
  async onRecordEdited(event: RecordEditedEvent): Promise<void> {
    const template = buildRecordEditedTemplate(event);
    await this.notifications.createForRoles(RECORD_EDITED_ROLES, {
      ...template,
      data: { entity: event.entity, entityId: event.entityId },
    });
  }

  @OnEvent(DOMAIN_EVENTS.ITEM_LOW_STOCK)
  async onItemLowStock(event: ItemLowStockEvent): Promise<void> {
    const template = buildItemLowStockTemplate(event);
    await this.notifications.createForRoles(ITEM_LOW_STOCK_ROLES, {
      ...template,
      data: {
        itemId: event.itemId,
        branchId: event.branchId,
        quantity: event.quantity,
        minimumQuantity: event.minimumQuantity,
      },
    });
  }

  /**
   * `shift.exit-report` — único lugar que envía la notificación in-app Y el
   * correo con el PDF adjunto para este evento (ver docstring de
   * `NotificationsService.notifyRolesWithAttachment`). SIEMPRE actualiza
   * `emailStatus` al final vía `ShiftReportsService.markEmailStatus`, incluso
   * si algo falla — nunca deja el `'PENDING'` inicial colgado, y nunca deja
   * escapar la excepción (el evento se emite fire-and-forget DESPUÉS de que
   * la fila ya se confirmó, así que un error acá no puede tumbar la request
   * HTTP igual, pero dejarlo escapar generaría un unhandled rejection). Solo
   * orquesta: la escritura de `ShiftExitReport` y la lectura del PDF viven en
   * `ShiftReportsService`, dueño de ese modelo.
   */
  @OnEvent(DOMAIN_EVENTS.SHIFT_EXIT_REPORT_SENT)
  async onShiftExitReportSent(event: ShiftExitReportSentEvent): Promise<void> {
    let emailStatus: ShiftExitReportEmailStatus;

    try {
      emailStatus = await this.sendShiftExitReportNotifications(event);
    } catch (error) {
      this.logger.error(
        `No se pudo procesar shift.exit-report (reportId="${event.reportId}")`,
        error instanceof Error ? error.stack : undefined,
      );
      emailStatus = 'FAILED';
    }

    try {
      await this.shiftReports.markEmailStatus(event.reportId, emailStatus);
    } catch (error) {
      this.logger.error(
        `No se pudo actualizar emailStatus del reporte "${event.reportId}"`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async sendShiftExitReportNotifications(
    event: ShiftExitReportSentEvent,
  ): Promise<ShiftExitReportEmailStatus> {
    const template = buildShiftExitReportSentTemplate(event);
    const data = { reportId: event.reportId, shiftId: event.shiftId };

    if (!this.mail.isConfigured()) {
      // Sin SMTP, igual se crea la notificación in-app — solo el correo
      // queda SKIPPED. `notifyRolesWithAttachment` de todas formas intentaría
      // `mail.sendMail` (no-op, devuelve false), así que evaluamos esto
      // ANTES para no reportar 'FAILED' por un no-op esperado.
      await this.notifications.createForRoles(SHIFT_EXIT_REPORT_ROLES, {
        ...template,
        data,
      });
      return 'SKIPPED';
    }

    const attachment = await this.shiftReports.getAttachment(event.reportId);
    const { recipientCount, allEmailsSent } =
      await this.notifications.notifyRolesWithAttachment(
        SHIFT_EXIT_REPORT_ROLES,
        { ...template, data },
        [attachment],
        env.shiftReportExtraRecipients,
      );

    if (recipientCount === 0) return 'SKIPPED';
    return allEmailsSent ? 'SENT' : 'FAILED';
  }
}
