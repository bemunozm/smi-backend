/**
 * Canal Web Push (VAPID). Tercer canal de notificaciones junto a la campanita
 * y el correo: `NotificationsService.createNotificationRow` dispara un push
 * por cada fila creada, a TODOS los dispositivos registrados del usuario.
 *
 * Best-effort por diseño: ningún error de acá puede propagarse a la creación
 * de la notificación ni al evento de dominio que la originó — `sendToUser`
 * nunca rechaza. Sin claves VAPID (desarrollo local), el canal queda
 * deshabilitado con un único warn al arrancar y la app funciona igual.
 */
import { Injectable, Logger } from '@nestjs/common';
import * as webPush from 'web-push';

import { env } from '../common/config/env';
import { PrismaService } from '../common/prisma/prisma.service';

export interface PushPayload {
  notificationId: string;
  tipo: string;
  titulo: string;
  cuerpo: string;
  data?: unknown;
}

export interface SaveSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

// Los push services rechazan payloads sobre ~4 KB; `record.edited` lista un
// cambio por línea y puede pasarse. 1000 caracteres dejan margen de sobra y
// el detalle completo sigue en la campanita y el correo.
const MAX_PUSH_BODY_CHARS = 1000;

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const code = (error as { statusCode: unknown }).statusCode;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly enabled: boolean;

  constructor(private readonly prisma: PrismaService) {
    if (env.vapidPublicKey && env.vapidPrivateKey) {
      webPush.setVapidDetails(
        env.vapidSubject,
        env.vapidPublicKey,
        env.vapidPrivateKey,
      );
      this.enabled = true;
    } else {
      this.enabled = false;
      this.logger.warn(
        'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY no configuradas: el canal Web Push queda deshabilitado',
      );
    }
  }

  getPublicKey(): string | null {
    return env.vapidPublicKey ?? null;
  }

  /**
   * Alta idempotente por `endpoint` (el navegador puede renovar la
   * suscripción). Si el endpoint ya existía con OTRO dueño (tablet compartida
   * donde el anterior no alcanzó a desuscribirse), se reasigna al usuario de
   * la sesión actual: el dispositivo recibe push de quien está logueado,
   * nunca del anterior.
   */
  async saveSubscription(
    userId: string,
    input: SaveSubscriptionInput,
  ): Promise<void> {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      update: {
        userId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent,
      },
      create: {
        userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent,
      },
    });
  }

  /** Ownership vía `deleteMany where:{userId,endpoint}` — idempotente: borrar
   * un endpoint ajeno o ya borrado no es error (0 filas afectadas). */
  async deleteSubscription(userId: string, endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  /** Nunca rechaza: cada suscripción se maneja por separado y cualquier error
   * inesperado (Prisma incluido) se absorbe con un warn. */
  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    if (!this.enabled) return;
    try {
      const subscriptions = await this.prisma.pushSubscription.findMany({
        where: { userId },
      });
      if (subscriptions.length === 0) return;

      const body = JSON.stringify({
        ...payload,
        cuerpo: truncateBody(payload.cuerpo),
      });
      await Promise.allSettled(
        subscriptions.map((sub) => this.sendToSubscription(sub, body)),
      );
    } catch (error) {
      this.logger.warn(
        `Push a userId="${userId}" falló sin enviarse: ${String(error)}`,
      );
    }
  }

  private async sendToSubscription(
    sub: SubscriptionRow,
    body: string,
  ): Promise<void> {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        body,
      );
    } catch (error) {
      const statusCode = statusCodeOf(error);
      // 404/410 = el push service declaró muerta la suscripción (app
      // desinstalada, permiso revocado): se limpia la fila acá mismo.
      if (statusCode === 404 || statusCode === 410) {
        await this.prisma.pushSubscription
          .deleteMany({ where: { endpoint: sub.endpoint } })
          .catch((deleteError: unknown) => {
            this.logger.warn(
              `No se pudo limpiar la suscripción muerta "${sub.endpoint}": ${String(deleteError)}`,
            );
          });
        return;
      }
      // Cualquier otro error (403 VAPID que no calza, 429, red) NO borra la
      // suscripción: puede ser transitorio o un problema nuestro.
      this.logger.warn(
        `Push a "${sub.endpoint}" falló (status ${statusCode ?? '?'}): ${String(error)}`,
      );
    }
  }
}

function truncateBody(cuerpo: string): string {
  if (cuerpo.length <= MAX_PUSH_BODY_CHARS) return cuerpo;
  return `${cuerpo.slice(0, MAX_PUSH_BODY_CHARS - 1)}…`;
}
