import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Patch,
} from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { NotificationsService } from './notifications.service';

function assertNonEmptyId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new BadRequestException('El parámetro "id" no puede estar vacío');
  }
}

/**
 * Notificaciones del usuario autenticado. Sin `@Roles`: son universales —
 * cada usuario ve y gestiona únicamente las suyas (ownership por `userId`
 * dentro del service, no por rol).
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  async findAll(@Session() session: UserSession) {
    const data = await this.service.listForUser(session.user.id);
    return { data, message: 'ok' };
  }

  // Antes de `:id/read` no hay ambigüedad (distinto número de segmentos),
  // pero se declara primero por convención de rutas más específicas antes.
  @Get('unread-count')
  async unreadCount(@Session() session: UserSession) {
    const count = await this.service.unreadCount(session.user.id);
    return { data: { count }, message: 'ok' };
  }

  @Patch('read-all')
  async markAllRead(@Session() session: UserSession) {
    await this.service.markAllRead(session.user.id);
    return { data: null, message: 'Notificaciones marcadas como leídas' };
  }

  @Patch(':id/read')
  async markRead(@Param('id') id: string, @Session() session: UserSession) {
    assertNonEmptyId(id);
    await this.service.markRead(session.user.id, id);
    return { data: { id }, message: 'Notificación marcada como leída' };
  }
}
