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

/** Forma válida de un `code` de negocio: UPPER_SNAKE_CASE, empieza con
 * letra. El filtro pasa a la respuesta CUALQUIER `code` con esta forma, esté
 * o no registrado en `ERROR_CODES` (ver `src/common/errors/error-codes.ts`):
 * ese catálogo es el contrato tipado para los throw sites, no un gate del
 * filtro. Si dependiera de estar en el inventario, un código de negocio
 * nuevo lanzado sin registrarlo ahí desaparecería en silencio de la
 * respuesta — y el outbox offline del front clasifica por `code`, así que
 * esa desaparición sería invisible hasta reventar en producción. Un valor
 * mal formado (minúsculas, espacios, no-string) sí se descarta: no
 * parece un clasificador de negocio real. */
const BUSINESS_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function isWellFormedErrorCode(value: unknown): value is string {
  return typeof value === 'string' && BUSINESS_ERROR_CODE_PATTERN.test(value);
}

interface ErrorResponseBody {
  data: null;
  message: string;
  /** Opcional: clasificador estable para que el caller (ej. el outbox
   * offline del front) distinga casos de negocio sin parsear `message`. Solo
   * aparece cuando quien lanzó la excepción lo puso explícito, ej.
   * `new ConflictException({ message, code: ERROR_CODES.EQUIPMENT_BUSY })`,
   * y tiene forma de código de negocio (UPPER_SNAKE) — no exige que esté
   * registrado en `ERROR_CODES`. */
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
   * `code` bien formado (UPPER_SNAKE) — nunca lo inventa a partir del
   * `message` ni del nombre de la excepción, y nunca lo exige del inventario
   * de `ERROR_CODES` (ver comentario de `BUSINESS_ERROR_CODE_PATTERN`). */
  private resolveCode(exception: unknown): string | undefined {
    if (!(exception instanceof HttpException)) return undefined;

    const body = exception.getResponse();
    if (typeof body !== 'object' || body === null || !('code' in body)) {
      return undefined;
    }

    const code = (body as { code?: unknown }).code;
    return isWellFormedErrorCode(code) ? code : undefined;
  }
}
