import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import {
  EXPECTED_HEADER,
  parseExpectedHeader,
  type ExpectedValues,
} from './expected-fields';

/**
 * Parámetro de controller con la precondición `X-Expected` ya parseada y
 * validada (`parseExpectedHeader`): `undefined` sin header, 400 si el header
 * viene mal. Reemplaza el par `@Headers(EXPECTED_HEADER)` + `parseExpectedHeader`
 * que cada PATCH repetía.
 */
export const ExpectedFields = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ExpectedValues | undefined => {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const raw = request.headers[EXPECTED_HEADER];
    // Un header repetido llega como arreglo: se junta igual que lo haría el
    // servidor HTTP, y queda como un JSON inválido (400) en vez de ignorarse.
    return parseExpectedHeader(Array.isArray(raw) ? raw.join(', ') : raw);
  },
);
