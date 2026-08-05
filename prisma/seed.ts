/**
 * Seed de usuarios de desarrollo — un usuario por cada rol del sistema.
 * Usa `auth.api.createUser` (no un insert directo a la BD) para que la
 * contraseña quede hasheada exactamente como Better Auth espera.
 *
 * IMPORTANTE: `auth.api.createUser` sólo aplica los checks de permisos de
 * admin cuando se le pasan `headers`/`request` en el contexto. Al llamarlo
 * server-side sin headers (como aquí), Better Auth lo trata como una
 * operación de confianza (trusted server call) y no exige sesión de admin
 * — es el patrón soportado para scripts de seed/migración.
 *
 * Prisma (Tier 2 #8): este script es un proceso Node aparte del server de
 * Nest, así que nunca corre `PrismaService.onModuleDestroy` automáticamente.
 * Para no abrir un segundo pool reutiliza el MISMO singleton `prismaClient`
 * que usa `auth.ts` (ver src/common/prisma/prisma.service.ts), y cierra la
 * conexión explícitamente al final.
 */
import { Logger } from '@nestjs/common';

import { prismaClient } from '../src/common/prisma/prisma.service';
import { auth } from '../src/auth/auth';
import { ROLES } from '../src/auth/roles';

const logger = new Logger('Seed');

const SEED_PASSWORD = 'Smi123456!';

interface SeedUser {
  name: string;
  email: string;
  role: (typeof ROLES)[keyof typeof ROLES];
}

const SEED_USERS: SeedUser[] = [
  { name: 'Admin SMI', email: 'admin@smi.local', role: ROLES.ADMIN },
  {
    name: 'Supervisor SMI',
    email: 'supervisor@smi.local',
    role: ROLES.SUPERVISOR,
  },
  {
    name: 'Mantenedor SMI',
    email: 'mantenedor@smi.local',
    role: ROLES.MANTENEDOR,
  },
  { name: 'Operador SMI', email: 'operador@smi.local', role: ROLES.OPERADOR },
];

function isUserAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'body' in error &&
    typeof (error as { body?: unknown }).body === 'object' &&
    (error as { body?: { code?: string } }).body?.code ===
      'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'
  );
}

async function seed(): Promise<void> {
  // A2 (auditoría de seguridad): el seed crea usuarios con contraseña de
  // desarrollo conocida — nunca debe poder correr contra un entorno de
  // producción, sin importar quién lo dispare.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Seed with dev credentials must NOT run in production');
  }

  for (const seedUser of SEED_USERS) {
    try {
      // Tier 3 #11: con `ac`/`roles` custom configurados en auth.ts, el
      // tipo de `role` ya infiere los 4 roles reales (ADMIN|SUPERVISOR|
      // MANTENEDOR|OPERADOR) — ya no hace falta castear contra el default
      // built-in "admin"|"user" de Better Auth.
      await auth.api.createUser({
        body: {
          email: seedUser.email,
          password: SEED_PASSWORD,
          name: seedUser.name,
          role: seedUser.role,
        },
      });
      logger.log(`Usuario creado: ${seedUser.email} (${seedUser.role})`);
    } catch (error) {
      if (isUserAlreadyExistsError(error)) {
        logger.warn(`Ya existía, se omite: ${seedUser.email}`);
        continue;
      }
      throw error;
    }
  }
}

// `void` en la cadena completa: es un script top-level (no dentro de una
// función async), y con `@typescript-eslint/no-floating-promises` en
// 'error' hay que marcar explícitamente que no se espera esta promesa.
void seed()
  .then(() => {
    logger.log('Seed completado.');
  })
  .catch((error: unknown) => {
    logger.error('Error ejecutando el seed', error as Error);
    process.exitCode = 1;
  })
  .finally(() => prismaClient.$disconnect());
