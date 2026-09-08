/**
 * Envío de correo transaccional (Núcleo → Notificaciones). El transport de
 * `nodemailer` se arma perezosamente desde `env` la primera vez que se llama
 * `sendMail`, y se cachea para el resto del proceso.
 *
 * SMTP es opcional (ver `common/config/env.ts`): si faltan las credenciales
 * mínimas (host/user/pass), el servicio queda en no-op — loguea un warning
 * una sola vez y no lanza, para no romper flujos que solo necesitan la
 * notificación in-app (la fila en `Notification` ya quedó creada antes de
 * llamar acá).
 */
import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

import { env } from '../common/config/env';

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null | undefined; // undefined = aún no resuelto

  async sendMail(input: SendMailInput): Promise<void> {
    const transporter = this.getTransporter();
    if (!transporter) {
      return;
    }

    try {
      await transporter.sendMail({
        from: env.smtpFrom ?? env.smtpUser,
        to: input.to,
        subject: input.subject,
        html: input.html,
      });
    } catch (error) {
      // El correo es best-effort: un SMTP caído no debe tumbar el flujo que
      // ya persistió la notificación in-app.
      this.logger.error(
        `No se pudo enviar el correo a ${input.to}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private getTransporter(): Transporter | null {
    if (this.transporter !== undefined) {
      return this.transporter;
    }

    if (!env.smtpHost || !env.smtpUser || !env.smtpPass) {
      this.logger.warn('email disabled: SMTP not configured');
      this.transporter = null;
      return this.transporter;
    }

    this.transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort ?? 587,
      secure: env.smtpSecure,
      auth: { user: env.smtpUser, pass: env.smtpPass },
    });
    return this.transporter;
  }
}
