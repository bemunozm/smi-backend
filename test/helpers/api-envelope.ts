/**
 * Shape estándar de las respuestas HTTP del backend (interceptor de éxito /
 * `HttpExceptionFilter`) — compartido por los e2e de este dominio
 * (`shift-register`, `trabajos-extra`, `equipment-assignment`) para no
 * redeclarar los mismos dos tipos en cada archivo.
 */
export interface ApiEnvelope<T> {
  data: T;
  message: string;
}

export interface ErrorEnvelope {
  data: null;
  message: string;
  code?: string;
}
