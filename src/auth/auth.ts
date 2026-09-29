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
    // Cierra el auto-registro público. Los usuarios se crean vía admin
    // plugin (auth.api.createUser) o el seed — nunca por self-service en
    // este sistema interno.
    disableSignUp: true,
  },
  trustedOrigins: [env.frontendUrl],
  // `/update-user` (endpoint propio de Better Auth, self-service —
  // cualquier usuario autenticado podría cambiar su propio `name`) está
  // DESHABILITADO. El frontend no lo usa: `UsersView` / `useUpdateUser`
  // llaman a nuestra API propia `/api/users` (admin-only, ver
  // `UsersModule`), nunca `authClient.updateUser` (confirmado por grep en
  // `smi-frontend/src`). Si algún día se habilita self-editing de nombre,
  // sacar esto de acá Y truncar/sanear ese `name` en los mismos puntos que
  // `ShiftReportsService` trunca `supervisorName` (PDF/correo).
  disabledPaths: ['/update-user'],
  // Rate limit nativo de Better Auth (para la prueba en terreno con túnel
  // HTTPS), `enabled` gobernado por
  // `AUTH_RATE_LIMIT_ENABLED` (ver env.ts) — `true` por defecto en
  // producción, `false` en el resto para no romper el e2e suite (hace login
  // muchas veces seguidas). `customRules` fija 5 intentos / 60s para
  // `/sign-in/email` en vez de confiar en la regla especial por defecto de
  // Better Auth (3/10s para cualquier path que empiece con `/sign-in`) —
  // SECURITY-NOTES.md pide explícitamente "5 intentos / 60s".
  rateLimit: {
    enabled: env.authRateLimitEnabled,
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
    },
  },
  plugins: [
    admin({
      // Roles de Access Control custom — ver access-control.ts para el
      // porqué (bug de hasPermission con roles en mayúscula).
      ac,
      roles,
      // Rol asignado por defecto a cualquier usuario nuevo. En la práctica
      // es INALCANZABLE hoy: `disableSignUp` cierra el auto-registro y
      // `CreateUserDto.role` es obligatorio en `POST /api/users` (única vía
      // de alta) — se mantiene solo por consistencia con lo que exige el
      // generador del plugin admin. MANTENEDOR (no OPERADOR: ese rol se
      // eliminó — el operador es un catálogo propio, `src/operators/*`, sin
      // acceso a la plataforma).
      defaultRole: ROLES.MANTENEDOR,
      // Únicos roles que el plugin admin trata como "administradores"
      // (habilita las capacidades de gestión de usuarios del plugin).
      adminRoles: [ROLES.ADMIN],
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
