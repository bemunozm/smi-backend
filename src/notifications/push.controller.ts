import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import {
  CreatePushSubscriptionDto,
  DeletePushSubscriptionDto,
} from './dto/push-subscription.dto';
import { PushService } from './push.service';

/**
 * Suscripciones Web Push del usuario autenticado. Sin `@Roles`: son
 * universales, como las notificaciones — cada usuario gestiona únicamente las
 * de su sesión (ownership por `userId` dentro del service).
 */
@Controller('push')
export class PushController {
  constructor(private readonly service: PushService) {}

  /** La clave pública viaja por endpoint (no horneada en el build del
   * frontend) para poder rotarla sin redesplegar la PWA. `null` = push
   * deshabilitado en este ambiente. */
  @Get('vapid-public-key')
  vapidPublicKey() {
    return { data: { publicKey: this.service.getPublicKey() }, message: 'ok' };
  }

  @Post('subscriptions')
  async subscribe(
    @Body() dto: CreatePushSubscriptionDto,
    @Session() session: UserSession,
  ) {
    await this.service.saveSubscription(session.user.id, {
      endpoint: dto.endpoint,
      p256dh: dto.keys.p256dh,
      auth: dto.keys.auth,
      userAgent: dto.userAgent,
    });
    return {
      data: null,
      message: 'Dispositivo suscrito a notificaciones push',
    };
  }

  @Delete('subscriptions')
  async unsubscribe(
    @Body() dto: DeletePushSubscriptionDto,
    @Session() session: UserSession,
  ) {
    await this.service.deleteSubscription(session.user.id, dto.endpoint);
    return {
      data: null,
      message: 'Dispositivo desuscrito de notificaciones push',
    };
  }
}
