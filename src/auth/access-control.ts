/**
 * BUG confirmado en auditoría (Tier 3 #11): sin `ac`/`roles` custom, el
 * plugin `admin` de Better Auth usa sus roles built-in en minúscula
 * (`admin`/`user`, ver `better-auth/plugins/admin/access/statement.mjs`) y
 * `hasPermission()` resuelve el rol con un lookup EXACTO por string
 * (`acRoles[role]`, ver `better-auth/plugins/admin/has-permission.mjs`).
 * Con nuestros roles en MAYÚSCULA (`ADMIN`, `SUPERVISOR`, ...) ese lookup
 * siempre fallaba (`acRoles["ADMIN"]` es `undefined` cuando `acRoles` solo
 * tiene `admin`/`user`) → CUALQUIER endpoint del plugin admin
 * (`/admin/create-user`, `/admin/set-role`, `/admin/ban-user`,
 * `/admin/list-users`, ...) devolvía FORBIDDEN para un ADMIN real
 * autenticado por sesión HTTP. Solo el seed funcionaba, porque
 * `auth.api.createUser` llamado server-side sin `headers` se trata como
 * operación de confianza y se salta el chequeo de permisos por completo
 * (no es una prueba válida de que los permisos funcionen vía HTTP).
 *
 * Fix: declarar los 4 roles reales del sistema como roles de Access Control
 * explícitos, reusando el catálogo de permisos base del plugin admin
 * (`defaultStatements`) en vez de reinventar los recursos/acciones.
 */
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements } from 'better-auth/plugins/admin/access';

import { ROLES } from './roles';

const statement = {
  ...defaultStatements,
} as const;

export const ac = createAccessControl(statement);

/**
 * ADMIN: control total de gestión de usuarios/sesiones — mismos permisos
 * que el rol `adminAc` built-in de Better Auth (los reusamos vía spread
 * para no duplicar el catálogo de acciones).
 */
const adminRole = ac.newRole({
  ...adminAc.statements,
});

/**
 * SUPERVISOR / MANTENEDOR / OPERADOR: placeholders SIN permisos del plugin
 * admin todavía (decisión del tech lead: "permisos livianos" en este MVP).
 * Lo importante en este tier es que existan como roles AC válidos — así
 * `hasPermission` los resuelve correctamente en vez de caer en el bug de
 * roles inexistentes. Los permisos finos (qué puede hacer cada rol sobre
 * qué recurso) se afinan cuando lleguen los endpoints de dominio.
 */
const supervisorRole = ac.newRole({
  user: [],
  session: [],
});

const mantenedorRole = ac.newRole({
  user: [],
  session: [],
});

const operadorRole = ac.newRole({
  user: [],
  session: [],
});

export const roles = {
  [ROLES.ADMIN]: adminRole,
  [ROLES.SUPERVISOR]: supervisorRole,
  [ROLES.MANTENEDOR]: mantenedorRole,
  [ROLES.OPERADOR]: operadorRole,
};
