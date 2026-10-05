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

/** Adjunto de correo — mismo shape mínimo que espera `nodemailer`. */
export interface MailAttachment {
  readonly filename: string;
  readonly content: Buffer;
  readonly contentType: string;
}

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  /** Opcional (el PDF de salida de turno viaja acá). Los callers que no
   * adjuntan nada no lo mandan. */
  attachments?: MailAttachment[];
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null | undefined; // undefined = aún no resuelto

  /**
   * Devuelve `true` cuando el correo efectivamente se intentó enviar (SMTP
   * configurado y `transporter.sendMail` no lanzó); `false` cuando quedó en
   * no-op (SMTP no configurado) o cuando el envío falló — en ambos casos SIN
   * lanzar (ver docstring de cabecera: el correo es best-effort). El booleano
   * es lo que usa `NotificationsService.notifyRolesWithAttachment` para
   * derivar `ShiftExitReport.emailStatus` (SENT/FAILED/SKIPPED); el resto de
   * los callers (fire-and-forget) simplemente lo ignora.
   */
  async sendMail(input: SendMailInput): Promise<boolean> {
    const transporter = this.getTransporter();
    if (!transporter) {
      return false;
    }

    try {
      await transporter.sendMail({
        from: env.smtpFrom ?? env.smtpUser,
        to: input.to,
        subject: input.subject,
        html: input.html,
        attachments: input.attachments,
      });
      return true;
    } catch (error) {
      // El correo es best-effort: un SMTP caído no debe tumbar el flujo que
      // ya persistió la notificación in-app.
      this.logger.error(
        `No se pudo enviar el correo a ${input.to}`,
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }
  }

  /** `true` si hay credenciales SMTP mínimas configuradas — mismo criterio
   * que `getTransporter()`, expuesto para que un caller (ej.
   * `NotificationsListener`) pueda distinguir "no hay SMTP" (SKIPPED) de "el
   * envío falló" (FAILED) sin duplicar la condición. */
  isConfigured(): boolean {
    return Boolean(env.smtpHost && env.smtpUser && env.smtpPass);
  }

  private getTransporter(): Transporter | null {
    if (this.transporter !== undefined) {
      return this.transporter;
    }

    if (!this.isConfigured()) {
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
