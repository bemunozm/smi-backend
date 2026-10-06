/**
 * Crea el PRIMER usuario ADMIN de un despliegue nuevo.
 *
 * Uso (las credenciales van por entorno, nunca por argumentos, para que no
 * queden en el historial de shell ni en `ps`):
 *   ADMIN_EMAIL=... ADMIN_NAME=... ADMIN_PASSWORD=... npm run user:create-admin
 *
 * Contexto: en producción `prisma/seed.ts` se niega a correr (borra datos),
 * `scripts/set-password.ts` solo rota la contraseña de un usuario que ya
 * existe y `disableSignUp` cierra el auto-registro — sin este script no hay
 * camino para el primer ADMIN, que es quien crea al resto desde la app.
 *
 * Es seguro de repetir: se niega si ya existe CUALQUIER ADMIN, así que no
 * sirve como puerta trasera para agregar admins después del primero (eso se
 * hace desde la app, con un ADMIN autenticado).
 *
 * Crea el usuario por `auth.api.createUser`, el mismo camino del seed y de
 * `UsersService.create`, para que la contraseña quede hasheada como Better
 * Auth espera y el rol validado contra `ac`/`roles`.
 */
import { Logger } from '@nestjs/common';
import { isEmail } from 'class-validator';

import { auth } from '../src/auth/auth';
import { ROLES } from '../src/auth/roles';
import { prismaClient } from '../src/common/prisma/prisma.service';
import { MIN_PASSWORD_LENGTH } from './set-password';

const logger = new Logger('CreateAdmin');

/** Errores de uso (env faltante/inválido, ya existe un ADMIN): mensaje accionable en vez de stack trace. */
export class CreateAdminUsageError extends Error {}

export interface AdminInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}

export interface CreateAdminDeps {
  countAdmins: () => Promise<number>;
  createAdmin: (input: AdminInput) => Promise<{ email: string }>;
}

/** Puro, sin I/O: lee y valida `ADMIN_EMAIL`/`ADMIN_NAME`/`ADMIN_PASSWORD`. */
export function readAdminInput(
  environment: Readonly<Record<string, string | undefined>>,
): AdminInput {
  const missing = ['ADMIN_EMAIL', 'ADMIN_NAME', 'ADMIN_PASSWORD'].filter(
    (name) => !environment[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new CreateAdminUsageError(
      `Faltan variables de entorno: ${missing.join(', ')} (nunca como argumentos de línea de comandos)`,
    );
  }

  const email = (environment.ADMIN_EMAIL as string).trim();
  const name = (environment.ADMIN_NAME as string).trim();
  const password = environment.ADMIN_PASSWORD as string;

  if (!isEmail(email)) {
    throw new CreateAdminUsageError(`ADMIN_EMAIL no es un correo válido`);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new CreateAdminUsageError(
      `ADMIN_PASSWORD debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
    );
  }
  return { email, name, password };
}

/** Lógica de negocio con las dependencias inyectadas, testeable sin DB ni Better Auth. */
export async function createFirstAdmin(
  deps: CreateAdminDeps,
  input: AdminInput,
): Promise<{ email: string }> {
  const existingAdmins = await deps.countAdmins();
  if (existingAdmins > 0) {
    throw new CreateAdminUsageError(
      `Ya existe ${existingAdmins} usuario(s) ADMIN: este script solo crea el primero. Crea los demás desde la app, con un ADMIN autenticado`,
    );
  }
  return deps.createAdmin(input);
}

function isUserAlreadyExistsError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('body' in error)) {
    return false;
  }
  const body = (error as { body?: { code?: string } }).body;
  return body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL';
}

const productionDeps: CreateAdminDeps = {
  countAdmins: () => prismaClient.user.count({ where: { role: ROLES.ADMIN } }),
  createAdmin: async (input) => {
    try {
      const result = await auth.api.createUser({
        body: {
          email: input.email,
          password: input.password,
          name: input.name,
          role: ROLES.ADMIN,
        },
      });
      return { email: result.user.email };
    } catch (error) {
      if (isUserAlreadyExistsError(error)) {
        throw new CreateAdminUsageError(
          `Ya existe un usuario con el email ${input.email} (y no es ADMIN): usa otro correo o súbele el rol desde la base de datos`,
        );
      }
      throw error;
    }
  },
};

async function main(): Promise<void> {
  const input = readAdminInput(process.env);
  const created = await createFirstAdmin(productionDeps, input);
  // Solo info NO sensible — nunca la contraseña.
  logger.log(`Admin creado: ${created.email}`);
}

// Guard de entry-point: el spec importa las funciones puras de este MISMO
// módulo; sin esto ese `import` correría `main()` contra el entorno real.
if (require.main === module) {
  void main()
    .catch((error: unknown) => {
      if (error instanceof CreateAdminUsageError) {
        logger.error(error.message);
      } else {
        logger.error(
          'Error inesperado ejecutando create-admin',
          error as Error,
        );
      }
      process.exitCode = 1;
    })
    .finally(() => prismaClient.$disconnect());
}
