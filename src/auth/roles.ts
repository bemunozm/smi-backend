/**
 * Roles del sistema SMI. Se mantienen como constantes de string (no enum
 * Prisma) para que Better Auth (plugin `admin`) y el `@Roles()` de
 * `@thallesp/nestjs-better-auth` trabajen con el mismo tipo literal sin
 * necesitar mapeos adicionales.
 *
 * Autorización por rol (decisión del tech lead, M4): se usa EXCLUSIVAMENTE
 * el `@Roles()`/`AuthGuard` que trae `@thallesp/nestjs-better-auth` — no hay
 * un guard propio en `src/common/`. El `AuthGuard` global ya lee la metadata
 * de `@Roles()` y compara contra `session.user.role` automáticamente; NO
 * hace falta agregar `@UseGuards(...)` adicional en el endpoint.
 *
 * Importa siempre `ROLES` (esta misma constante) al declarar `@Roles(...)`
 * — nunca repitas el string literal a mano, para que un typo o un rename
 * de rol no pueda desincronizar el guard de su fuente única de verdad.
 *
 * @example
 * ```ts
 * import { Controller, Get } from '@nestjs/common';
 * import { Roles } from '@thallesp/nestjs-better-auth';
 * import { ROLES } from '../auth/roles';
 *
 * @Controller('admin')
 * export class AdminController {
 *   @Roles([ROLES.ADMIN])
 *   @Get('dashboard')
 *   dashboard() {
 *     // Solo session.user.role === 'ADMIN' pasa. El AuthGuard global ya
 *     // lo enforce; no se necesita @UseGuards(RolesGuard) manual.
 *     return { message: 'admin only' };
 *   }
 *
 *   @Roles([ROLES.ADMIN, ROLES.SUPERVISOR])
 *   @Get('reportes')
 *   reportes() {
 *     return { message: 'admin o supervisor' };
 *   }
 * }
 * ```
 */
export const ROLES = {
  ADMIN: 'ADMIN',
  SUPERVISOR: 'SUPERVISOR',
  MANTENEDOR: 'MANTENEDOR',
  OPERADOR: 'OPERADOR',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: readonly Role[] = Object.values(ROLES);
