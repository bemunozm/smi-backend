import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Respuesta<T> {
  data: T;
  message: string;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, Respuesta<T>> {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<Respuesta<T>> {
    return next.handle().pipe(map((data) => ({ data: data ?? null, message: 'OK' }) as Respuesta<T>));
  }
}
