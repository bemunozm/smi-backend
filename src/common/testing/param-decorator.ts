import type { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';

interface RouteArgMetadata {
  factory: (data: unknown, context: ExecutionContext) => unknown;
}

/**
 * Corre un decorador de parámetro (`createParamDecorator`) contra un request
 * falso: lo aplica a un método de una clase de prueba, recupera su `factory`
 * del metadata de Nest y la invoca con un `ExecutionContext` mínimo.
 */
export function runParamDecorator(
  decorator: () => ParameterDecorator,
  request: object,
): unknown {
  class Probe {
    // Solo importa el metadata del parámetro: el método nunca se invoca.
    handler(): void {}
  }
  decorator()(Probe.prototype, 'handler', 0);

  const metadata = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    Probe,
    'handler',
  ) as Record<string, RouteArgMetadata>;
  const [{ factory }] = Object.values(metadata);

  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return factory(undefined, context);
}
