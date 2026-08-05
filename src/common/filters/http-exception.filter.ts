import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload =
      exception instanceof HttpException ? exception.getResponse() : 'Error interno del servidor';
    const raw =
      typeof payload === 'string' ? payload : (payload as { message: string | string[] }).message;
    const message = Array.isArray(raw) ? raw.join(', ') : raw;
    res.status(status).json({ data: null, message });
  }
}
