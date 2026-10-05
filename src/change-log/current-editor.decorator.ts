import {
  createParamDecorator,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import type { Editor } from './change-log.service';

/**
 * Quién edita, derivado de la sesión y nunca del body: es la firma del cambio
 * en el historial. Sin nombre se usa el correo.
 */
export function toEditor(
  user: Pick<UserSession['user'], 'id' | 'name' | 'email'>,
): Editor {
  return { id: user.id, name: user.name?.trim() || user.email };
}

/** Parámetro de controller: el `Editor` de la sesión autenticada. */
export const CurrentEditor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Editor => {
    const { session } = context
      .switchToHttp()
      .getRequest<{ session?: UserSession }>();
    if (!session) throw new UnauthorizedException();
    return toEditor(session.user);
  },
);
