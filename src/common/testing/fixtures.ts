/**
 * Fixtures de test compartidos entre specs de servicios (`*.service.spec.ts`)
 * — antes duplicados, byte a byte en varios casos, en cada archivo.
 */
import { Prisma } from '@prisma/client';
import type { UserSession } from '@thallesp/nestjs-better-auth';

/** Construye un error de Prisma REAL (no un duck-type) para que el
 * `instanceof Prisma.PrismaClientKnownRequestError` que usan los servicios al
 * mapear errores (ej. P2002 → 409) lo reconozca. */
export function prismaError(
  code: string,
  meta?: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('mocked prisma error', {
    code,
    clientVersion: 'test',
    meta,
  });
}

/** Mock mínimo de `UserSession` — mismo patrón que `users.controller.spec.ts`.
 * `name` solo importa a los callers que lo leen (ej. `ShiftReportsService`,
 * para `supervisorName`); el resto lo ignora. */
export function buildSession(
  userId: string,
  role = 'SUPERVISOR',
  name = 'Test User',
): UserSession {
  return {
    user: { id: userId, role, name },
    session: { id: 'session_1' },
  } as unknown as UserSession;
}
