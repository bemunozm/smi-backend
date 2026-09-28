/**
 * Escucha los 4 eventos de dominio (`common/events/domain-events.ts`) y los
 * traduce a notificaciones vía `NotificationsService`. Los dominios que
 * disparan estos eventos (Terreno/Mantenimiento/Inventario) se conectan en
 * una fase posterior — este listener ya queda listo para recibirlos.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { env } from '../common/config/env';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  DOMAIN_EVENTS,
  type HallazgoCreatedEvent,
  type ItemLowStockEvent,
  type OrdenAssignedEvent,
  type OrdenCompletedEvent,
  type ShiftExitReportSentEvent,
} from '../common/events/domain-events';
import { MailService } from '../mail/mail.service';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from './notifications.service';
import {
  HALLAZGO_CREATED_ROLES,
  ITEM_LOW_STOCK_ROLES,
  ORDEN_ASSIGNED_ROLES,
  ORDEN_COMPLETED_ROLES,
  SHIFT_EXIT_REPORT_ROLES,
  buildHallazgoCreatedTemplate,
  buildItemLowStockTemplate,
  buildOrdenAssignedTemplate,
  buildOrdenCompletedTemplate,
  buildShiftExitReportSentTemplate,
} from './notifications.constants';

/** `ShiftExitReport.emailStatus` — mismo vocabulario libre (string) que el
 * resto del schema de Terreno, ver `prisma/schema.prisma`. */
type ShiftExitReportEmailStatus = 'SENT' | 'FAILED' | 'SKIPPED';

@Injectable()
export class NotificationsListener {
  private readonly logger = new Logger(NotificationsListener.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
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
   * `shift.exit-report` (RFC Supervisión en Terreno, Fase 3) — único lugar
   * que envía la notificación in-app Y el correo con el PDF adjunto para
   * este evento (ver docstring de `NotificationsService.notifyRolesWithAttachment`).
   * SIEMPRE actualiza `ShiftExitReport.emailStatus`/`notifiedAt` al final,
   * incluso si algo falla — nunca deja el `'PENDING'` inicial colgado, y
   * nunca deja escapar la excepción (el evento se emite fire-and-forget
   * DESPUÉS de que la fila ya se confirmó, así que un error acá no puede
   * tumbar la request HTTP igual, pero dejarlo escapar generaría un unhandled
   * rejection).
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
      await this.prisma.shiftExitReport.update({
        where: { id: event.reportId },
        data: { emailStatus, notifiedAt: new Date() },
      });
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

    const pdfBuffer = await this.storage.getObjectBuffer(event.fileKey);
    const { recipientCount, allEmailsSent } =
      await this.notifications.notifyRolesWithAttachment(
        SHIFT_EXIT_REPORT_ROLES,
        { ...template, data },
        [
          {
            filename: event.fileName,
            content: pdfBuffer,
            contentType: 'application/pdf',
          },
        ],
        env.shiftReportExtraRecipients,
      );

    if (recipientCount === 0) return 'SKIPPED';
    return allEmailsSent ? 'SENT' : 'FAILED';
  }
}
