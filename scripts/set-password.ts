/**
 * Rota la contraseña de un usuario EXISTENTE (cuenta `credential` de Better
 * Auth) y revoca sus sesiones vigentes — sin dejar la contraseña en el
 * historial de shell.
 *
 * Uso:
 *   NEW_PASSWORD='...' npm run user:set-password -- --email admin@smi.local
 *
 * Contexto (SECURITY-NOTES.md, TUNNEL CHECKLIST): antes de esta iteración no
 * existía forma de rotar las contraseñas seed — `prisma/seed.ts` es
 * idempotente por email (`seedUsers` omite silenciosamente los usuarios que
 * ya existen) y no hay flujo de "olvidé mi contraseña" (`emailAndPassword`
 * en `src/auth/auth.ts` corre sin verificación de email ni password reset,
 * decisión del tech lead para el MVP). Necesario antes de exponer el dev
 * server por un túnel HTTPS para la prueba en tablet.
 *
 * Hashea EXACTO como Better Auth hashea una cuenta `credential`:
 * `better-auth/crypto`.`hashPassword` es el mismo default que
 * `ctx.context.password.hash` usa internamente cuando
 * `emailAndPassword.password.hash` no se sobreescribe — y `auth.ts` no lo
 * sobreescribe (confirmado en
 * `node_modules/better-auth/dist/context/create-context.mjs`).
 *
 * Deliberadamente NO usa `auth.api.setUserPassword` (plugin admin): ese
 * endpoint corre detrás de `adminMiddleware`, que exige una sesión de admin
 * ya autenticada en `ctx.context.session` (ver
 * `node_modules/better-auth/dist/plugins/admin/routes.mjs`) — no hay forma
 * de satisfacer eso desde un script de servidor sin credenciales YA
 * vigentes, que es justo el problema que este script existe para resolver
 * (rotar una contraseña cuando puede que ni siquiera se recuerde la actual).
 *
 * Reutiliza el mismo runner que `prisma/seed.ts` (`ts-node --transpile-only`,
 * ver el bloque `"prisma"` de `package.json`) y el mismo singleton
 * `prismaClient` — nunca un segundo pool de conexiones.
 */
import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { hashPassword } from 'better-auth/crypto';

import { prismaClient } from '../src/common/prisma/prisma.service';

const logger = new Logger('SetPassword');

/**
 * Mínimo real que Better Auth exigiría si la contraseña se hubiera puesto
 * por el flujo normal (`auth.api.setUserPassword`/sign-up): default interno
 * cuando `emailAndPassword.minPasswordLength` no se sobreescribe (ver
 * `node_modules/better-auth/dist/context/create-context.mjs`,
 * `options.emailAndPassword?.minPasswordLength || 8`). `src/auth/auth.ts` no
 * lo sobreescribe — así que 8 es el mínimo vigente hoy. Si algún día se
 * agrega `minPasswordLength` explícito a `auth.ts`, actualizar acá también.
 */
export const MIN_PASSWORD_LENGTH = 8;

const CREDENTIAL_PROVIDER_ID = 'credential';

/** Errores de uso (argumentos/env faltantes o inválidos) — se distinguen de
 * errores inesperados de infraestructura solo para loguear un mensaje
 * accionable en vez de un stack trace crudo; ambos igual terminan el
 * proceso con código de salida distinto de 0. */
export class SetPasswordUsageError extends Error {}

export interface SetPasswordArgs {
  readonly email: string;
}

/**
 * Parseo puro de `argv` (sin `process.argv` adentro) — testeable sin mocks
 * de red/DB. Acepta `--email <email>`; cualquier otra forma (falta el flag,
 * falta el valor, o el valor "parece" otro flag) es un error de uso.
 */
export function parseArgs(argv: readonly string[]): SetPasswordArgs {
  const flagIndex = argv.indexOf('--email');
  const email = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  if (!email || email.startsWith('--')) {
    throw new SetPasswordUsageError(
      'Uso: NEW_PASSWORD=... npm run user:set-password -- --email <email>',
    );
  }
  return { email };
}

/**
 * Igual: puro, sin I/O. La contraseña NUNCA se lee desde `argv` — siempre
 * desde la variable de entorno `NEW_PASSWORD`, para que no quede en el
 * historial de shell ni en `ps`/logs de proceso.
 */
export function assertValidNewPassword(
  rawValue: string | undefined,
  minLength: number = MIN_PASSWORD_LENGTH,
): string {
  if (!rawValue) {
    throw new SetPasswordUsageError(
      'Falta la variable de entorno NEW_PASSWORD (nunca como argumento de línea de comandos)',
    );
  }
  if (rawValue.length < minLength) {
    throw new SetPasswordUsageError(
      `NEW_PASSWORD debe tener al menos ${minLength} caracteres`,
    );
  }
  return rawValue;
}

async function main(): Promise<void> {
  const { email } = parseArgs(process.argv.slice(2));
  const newPassword = assertValidNewPassword(process.env.NEW_PASSWORD);

  const user = await prismaClient.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) {
    throw new SetPasswordUsageError(`No existe un usuario con email ${email}`);
  }

  const hashedPassword = await hashPassword(newPassword);

  const updated = await prismaClient.account.updateMany({
    where: { userId: user.id, providerId: CREDENTIAL_PROVIDER_ID },
    data: { password: hashedPassword },
  });
  if (updated.count === 0) {
    // Mismo fallback que `auth.api.setUserPassword` (ver
    // `routes.mjs` del plugin admin): un usuario sin cuenta `credential`
    // (ej. creado solo por OAuth — no aplica hoy en este sistema, que cierra
    // el self-signup, pero cubre el caso) la crea en vez de fallar en
    // silencio.
    await prismaClient.account.create({
      data: {
        id: randomUUID(),
        userId: user.id,
        providerId: CREDENTIAL_PROVIDER_ID,
        accountId: user.id,
        password: hashedPassword,
      },
    });
  }

  // Revoca TODAS las sesiones vigentes del usuario — cualquier cookie
  // firmada con la contraseña anterior deja de servir para nada útil (la
  // sesión ya no existe en `session`, sin importar que el token siga siendo
  // criptográficamente válido).
  const revoked = await prismaClient.session.deleteMany({
    where: { userId: user.id },
  });

  // Solo info NO sensible — nunca la contraseña ni su hash.
  logger.log(
    `Password actualizado para ${email}, ${revoked.count} sesiones revocadas`,
  );
}

// Guard de entry-point: `set-password.spec.ts` importa `parseArgs`/
// `assertValidNewPassword` de este MISMO módulo para testear las partes
// puras sin tocar Prisma — sin este guard, ese `import` dispararía `main()`
// de verdad en cada corrida de test (contra `process.argv`/`NEW_PASSWORD`
// reales del proceso de Jest), dejando `process.exitCode` contaminado aunque
// todos los tests pasen.
if (require.main === module) {
  void main()
    .catch((error: unknown) => {
      if (error instanceof SetPasswordUsageError) {
        logger.error(error.message);
      } else {
        logger.error(
          'Error inesperado ejecutando set-password',
          error as Error,
        );
      }
      process.exitCode = 1;
    })
    .finally(() => prismaClient.$disconnect());
}
