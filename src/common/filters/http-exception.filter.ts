/**
 * Homogeniza TODAS las respuestas de error del pipeline de Nest (guards,
 * pipes, interceptors, controllers) al shape `{ data, message }` del
 * proyecto.
 *
 * NO afecta al handler de Better Auth (`/api/auth/*`): ese handler corre
 * como middleware Express crudo, registrado en `AuthModule` vía
 * `MiddlewareConsumer.forRoutes(basePath)` — responde y termina el ciclo
 * de request ANTES de entrar al pipeline de controllers/guards de Nest, así
 * que este `@Catch()` global nunca lo intercepta (confirmado empíricamente:
 * `/api/auth/sign-up/email` con `disableSignUp` sigue devolviendo el shape
 * nativo de Better Auth `{ message, code }`, no `{ data, message }`).
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

interface ErrorResponseBody {
  data: null;
  message: string;
  /** Opcional: clasificador estable para que el caller (ej. el outbox
   * offline del front) distinga casos de negocio sin parsear `message`. Solo
   * aparece cuando quien lanzó la excepción lo puso explícito, ej.
   * `new ConflictException({ message, code: 'EQUIPMENT_BUSY' })`. */
  code?: string;
}

// `resolveStatus` devuelve `number` (viene de `exception.getStatus()`, no
// tipado como enum), así que comparamos contra una constante numérica en
// vez del enum directamente para evitar `no-unsafe-enum-comparison`.
const INTERNAL_SERVER_ERROR_STATUS: number = HttpStatus.INTERNAL_SERVER_ERROR;

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status = this.resolveStatus(exception);
    const message = this.resolveMessage(exception, status);
    const code = this.resolveCode(exception);

    if (status >= INTERNAL_SERVER_ERROR_STATUS) {
      this.logger.error(
        `${status} ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${status} ${message}${code ? ` (${code})` : ''}`);
    }

    const body: ErrorResponseBody = {
      data: null,
      message,
      ...(code ? { code } : {}),
    };
    response.status(status).json(body);
  }

  private resolveStatus(exception: unknown): number {
    return exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private resolveMessage(exception: unknown, status: number): string {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        return body;
      }
      if (typeof body === 'object' && body !== null && 'message' in body) {
        const message = body.message;
        if (typeof message === 'string') {
          return message;
        }
        if (Array.isArray(message)) {
          return message
            .filter((m): m is string => typeof m === 'string')
            .join(', ');
        }
      }
      return exception.message;
    }
    return status === INTERNAL_SERVER_ERROR_STATUS
      ? 'Internal server error'
      : 'Unexpected error';
  }

  /** `undefined` salvo que el body de la excepción sea un objeto con un
   * `code` de tipo string explícito — nunca lo inventa a partir del
   * `message` ni del nombre de la excepción. */
  private resolveCode(exception: unknown): string | undefined {
    if (!(exception instanceof HttpException)) return undefined;

    const body = exception.getResponse();
    if (typeof body !== 'object' || body === null || !('code' in body)) {
      return undefined;
    }

    const code = (body as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
}
