import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin } from 'better-auth/plugins/admin';

import { prismaClient } from '../common/prisma/prisma.service';
import { env } from '../common/config/env';
import { ac, roles } from './access-control';
import { ROLES } from './roles';

export const auth = betterAuth({
  basePath: '/api/auth',
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  // Misma instancia de PrismaClient que gestiona `PrismaService` (ver
  // src/common/prisma/prisma.service.ts) — nunca un segundo pool.
  database: prismaAdapter(prismaClient, {
    provider: 'postgresql',
  }),
  emailAndPassword: {
    enabled: true,
    // MVP: sin verificación de email ni password reset (decisión del tech lead).
    requireEmailVerification: false,
    // A1 (auditoría de seguridad): cierra el auto-registro público. Los
    // usuarios se crean vía admin plugin (auth.api.createUser) o el seed —
    // nunca por self-service en este sistema interno.
    disableSignUp: true,
  },
  trustedOrigins: [env.frontendUrl],
  plugins: [
    admin({
      // Tier 3 #11: roles de Access Control custom — ver access-control.ts
      // para el porqué (bug de hasPermission con roles en mayúscula).
      ac,
      roles,
      // Rol asignado por defecto a cualquier usuario nuevo.
      defaultRole: ROLES.OPERADOR,
      // Únicos roles que el plugin admin trata como "administradores"
      // (habilita las capacidades de gestión de usuarios del plugin).
      adminRoles: [ROLES.ADMIN],
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
