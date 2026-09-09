/**
 * Notificaciones in-app + correo (Núcleo). Universal: cada usuario ve/gestiona
 * solo las suyas (ownership por `userId`, sin roles). Alimentado por
 * `NotificationsListener`, que reacciona a los eventos de dominio.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Notification, Prisma } from '@prisma/client';

import type { Role } from '../auth/roles';
import { escapeHtml } from '../mail/html-escape.util';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../common/prisma/prisma.service';
import type { UserResponseDto } from '../users/dto/user-response.dto';
import { UsersService } from '../users/users.service';

const LIST_TAKE = 50;
// El fan-out por rol resuelve todos los usuarios de ese rol (ADMIN/SUPERVISOR
// en la práctica, grupos chicos). Se acota igual como salvaguarda ante un
// rol mal usado a futuro que termine incluyendo a toda la dotación.
const MAX_FANOUT_RECIPIENTS = 200;

export interface CreateNotificationInput {
  tipo: string;
  titulo: string;
  cuerpo: string;
  data?: Prisma.InputJsonValue;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly users: UsersService,
  ) {}

  listForUser(userId: string): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: LIST_TAKE,
    });
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, leida: false },
    });
  }

  /** Ownership vía `updateMany where:{id,userId}` — 0 filas afectadas = 404. */
  async markRead(userId: string, id: string): Promise<void> {
    const result = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { leida: true },
    });
    if (result.count === 0) {
      throw new NotFoundException(`Notificación "${id}" no encontrada`);
    }
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, leida: false },
      data: { leida: true },
    });
  }

  /**
   * Crea 1 notificación para un usuario puntual e intenta el correo
   * (best-effort: `MailService` ya absorbe sus propios errores, y si el
   * usuario no tiene email resoluble simplemente se omite el envío).
   */
  async createForUser(
    userId: string,
    input: CreateNotificationInput,
  ): Promise<Notification> {
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        tipo: input.tipo,
        titulo: input.titulo,
        cuerpo: input.cuerpo,
        data: input.data,
      },
    });

    const recipient = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!recipient?.email) {
      this.logger.warn(
        `createForUser: no se encontró email para userId="${userId}", se omite el correo`,
      );
      return notification;
    }

    await this.mail.sendMail({
      to: recipient.email,
      subject: input.titulo,
      html: this.buildEmailHtml(input.titulo, input.cuerpo),
    });

    return notification;
  }

  /**
   * Fan-out: resuelve los usuarios de los roles dados (vía
   * `UsersService.findByRole`, que ya trae el email — no hace falta un
   * segundo lookup) y crea una fila + dispara un correo por cada uno.
   */
  async createForRoles(
    roles: readonly Role[],
    input: CreateNotificationInput,
  ): Promise<Notification[]> {
    const usersByRole = await Promise.all(
      roles.map((role) => this.users.findByRole(role)),
    );

    // Un usuario tiene un único `role`, así que en teoría no puede repetirse
    // entre roles distintos — se dedupea por id de todas formas como
    // salvaguarda barata.
    const uniqueRecipients = new Map<string, UserResponseDto>();
    for (const usersOfRole of usersByRole) {
      for (const user of usersOfRole) {
        uniqueRecipients.set(user.id, user);
      }
    }

    let recipients = Array.from(uniqueRecipients.values());
    if (recipients.length > MAX_FANOUT_RECIPIENTS) {
      this.logger.warn(
        `Fan-out de notificación "${input.tipo}" acotado a ${MAX_FANOUT_RECIPIENTS} destinatarios (había ${recipients.length})`,
      );
      recipients = recipients.slice(0, MAX_FANOUT_RECIPIENTS);
    }

    return Promise.all(
      recipients.map((recipient) => this.notifyRecipient(recipient, input)),
    );
  }

  private async notifyRecipient(
    recipient: UserResponseDto,
    input: CreateNotificationInput,
  ): Promise<Notification> {
    const notification = await this.prisma.notification.create({
      data: {
        userId: recipient.id,
        tipo: input.tipo,
        titulo: input.titulo,
        cuerpo: input.cuerpo,
        data: input.data,
      },
    });

    await this.mail.sendMail({
      to: recipient.email,
      subject: input.titulo,
      html: this.buildEmailHtml(input.titulo, input.cuerpo),
    });

    return notification;
  }

  private buildEmailHtml(titulo: string, cuerpo: string): string {
    return `<h1>${escapeHtml(titulo)}</h1><p>${escapeHtml(cuerpo)}</p>`;
  }

  /**
   * Resuelve un ref de equipo (id cuid o código) a su id real, o null si no
   * existe. `OrdenTrabajo.equipoId` es un soft-ref y la UI de creación de OT
   * (texto libre) suele guardar el código (ej. "EX-001") en vez del id, lo
   * que rompe la navegación del front a `/equipos/:id/ficha` si se propaga
   * tal cual en `data.equipoId`.
   */
  async resolveEquipoId(
    ref: string | null | undefined,
  ): Promise<string | null> {
    if (!ref) return null;
    const equipo = await this.prisma.equipment.findFirst({
      where: { OR: [{ id: ref }, { internalCode: ref }] },
      select: { id: true },
    });
    return equipo?.id ?? null;
  }
}
