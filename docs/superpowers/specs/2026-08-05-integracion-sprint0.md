# Plan de integración con el Sprint 0 (Benjamín)

**Fecha:** 2026-08-05 · **Autor:** Alexander Farias · **Bloque:** Operación en Terreno

Guía para reconciliar el scaffolding de Terreno (esta rama `feat/terreno/scaffolding`)
con la base real del Sprint 0 que Benjamín ya mergeó en `main`. Se ejecuta cuando el
equipo defina el **schema de dominio** (ver bloqueante §4).

## 0. Decisiones tomadas (Alexander)

- **Alcance ahora:** solo preparar la integración de infraestructura. **No** se toca el
  dominio de terreno todavía (queda intacto en la rama), porque depende de un `Equipo`
  que aún no existe.
- **Layout:** al integrar, se **mantiene la UI mobile** (mockup) para las pantallas de
  Terreno; no se adopta el layout desktop (Sidebar/Topbar) de la base.

## 1. Qué trae el Sprint 0 de Benjamín (a REUTILIZAR — no duplicar)

**Backend (`smi-backend@main`):**
- **Postgres vía Docker** (`docker-compose.yml`, puerto host **5433**), `.env.example`
  con `DATABASE_URL` de Postgres + `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`/`FRONTEND_URL`.
- **Better Auth** (`better-auth` + `@thallesp/nestjs-better-auth`): `src/auth/` (`auth.ts`,
  `roles.ts`, `access-control.ts`). **AuthGuard global** → todo endpoint exige sesión;
  autorización por rol con `@Roles([ROLES.X])` de `@thallesp/nestjs-better-auth` (import
  `ROLES` de `src/auth/roles.ts`). **No hay guard propio.**
- **PrismaService singleton** en `src/common/prisma/prisma.service.ts` (export `prismaClient`
  + `PrismaService` por DI). Postgres.
- **`main.ts`:** `bodyParser:false` (Better Auth), CORS único en main (`env.frontendUrl`,
  incluye PATCH/DELETE), `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`,
  prefijo `/api`, `enableShutdownHooks`.
- **Shape de respuesta `{ data, message }` MANUAL por controller** (ver `users.controller.ts`),
  **no** interceptor global. Errores homogeneizados por `HttpExceptionFilter` (`src/common/filters`).
- **Seed** (`prisma/seed.ts`, `npm run db:seed`) crea 1 usuario por rol vía `auth.api.createUser`,
  reusando el `prismaClient` singleton. `package.json#prisma.seed` usa `ts-node --transpile-only`.
- `src/health/`, `src/users/`, `@nestjs/config` (env global).

**Frontend (`smi-frontend@main`):**
- `src/lib/auth-client.ts` (Better Auth React client), `src/lib/axios.ts` (instancia),
  `src/lib/query-client.ts`, `src/context/AppProviders.tsx`.
- `src/components/ProtectedRoute.tsx` / `GuestRoute.tsx`, `src/views/LoginView.tsx`,
  `src/routes.tsx`, `src/config/nav-items.ts`, `src/hooks/useCurrentUser.ts`.
- Layout **desktop**: `src/layout/{AppLayout,Sidebar,Topbar}.tsx`.

## 2. Qué de mi base PROVISIONAL se BORRA y por cuál equivalente

**Backend — borrar de mi rama (todo marcado `PROVISIONAL`) y usar lo de Benjamín:**

| Mi provisional | Reemplazo (Sprint 0) |
|---|---|
| `src/prisma/prisma.service.ts` + `prisma.module.ts` | `src/common/prisma/prisma.service.ts` (+ su `PrismaModule`) |
| `src/common/decorators/roles.decorator.ts` + `guards/roles.guard.ts` | `@Roles([ROLES.X])` de `@thallesp/nestjs-better-auth` + `src/auth/roles.ts` |
| `src/common/interceptors/transform.interceptor.ts` + `common.module.ts` | Retornar `{ data, message }` **manual** en cada handler (patrón `users.controller`) |
| `src/common/filters/http-exception.filter.ts` (mío) | El de Benjamín (ya en `src/common/filters`) |
| `src/main.ts` + `src/app.module.ts` (míos) | Los de Benjamín (registrar mis módulos en su `app.module`) |
| `src/modules/equipos/` (endpoint provisional) | El real de Amin/Flota cuando exista (o mantener si nadie lo cubre) |
| `prisma/schema.prisma` (SQLite, Equipo placeholder) | Postgres; `Equipo` lo define el equipo (§4). Enums Prisma ahora sí posibles |
| header `x-dev-role` | Sesión real de Better Auth |

**Frontend — borrar de mi rama y usar lo de Benjamín:**

| Mi provisional | Reemplazo (Sprint 0) |
|---|---|
| `src/shared/store/auth.store.ts` (selector de rol dev) | `useCurrentUser` / `auth-client` (`useSession`) |
| `src/shared/api/client.ts` (axios propio + `x-dev-role`) | `src/lib/axios.ts` |
| `src/shared/lib/query.ts` | `src/lib/query-client.ts` |
| `src/main.tsx` + `src/shared/router.tsx` (míos) | `src/context/AppProviders.tsx` + `src/routes.tsx` (agregar mis rutas de Terreno) |
| Ruta abierta sin login | Detrás de `ProtectedRoute` |

**Se MANTIENE (mi dominio):** `src/modules/terreno/*` (back) y `src/modules/terreno/*` +
`src/shared/ui/mobile.tsx` + kit mobile (front). La **UI mobile** de Terreno se conserva
(decisión §0), integrada dentro de la app de Benjamín.

## 3. Pasos de integración (ejecutar cuando exista `Equipo` — §4)

**Backend:**
1. `git rebase origin/main` (mi rama sobre el Sprint 0). Resolver conflictos tomando la
   infra de Benjamín (tabla §2).
2. Borrar mi base provisional (§2). Mover el shape `{data,message}` a manual en mis
   controllers de terreno (o dejar que devuelvan `{ data, message }`).
3. Repuntar imports de mis services: `PrismaService` desde `src/common/prisma`.
4. Auth: reemplazar `@Roles('SUPERVISOR','ADMIN')` (mío) por `@Roles([ROLES.SUPERVISOR, ROLES.ADMIN])`
   de `@thallesp/nestjs-better-auth`. Recordar: el AuthGuard global ya exige sesión → los `GET`
   de terreno también requieren login.
5. Schema: agregar mis 4 modelos (`RegistroCombustible`, `RegistroHorometro`,
   `TrabajoExtraordinario`, `Hallazgo`) al **schema de dominio** (donde el equipo decida, §4),
   con la relación al `Equipo` real. Migrar con Postgres (`npm run prisma:migrate`).
6. Seed: agregar el seed de **mis tablas** (como pide Benjamín) reusando `prismaClient` +
   los equipos que siembre Flota. Integrar en `prisma/seed.ts` o un seed de terreno.
7. Uploads (Multer, `src/modules/uploads`): mantener; validar con `forbidNonWhitelisted`.
8. Registrar `TerrenoModule` + `UploadsModule` en el `app.module` de Benjamín.

**Frontend:**
1. `git rebase origin/main`. Tomar la infra de Benjamín (tabla §2).
2. Reapuntar mis `api/*.ts` de terreno al `src/lib/axios.ts` de ellos (mismo `{data,message}` →
   `res.data.data` sigue válido). Borrar mi `shared/api/client`, `shared/store/auth.store`,
   `shared/lib/query`.
3. Montar mis vistas de Terreno como rutas en `src/routes.tsx`, detrás de `ProtectedRoute`,
   **conservando el shell mobile** (mi `AppLayout` mobile envuelve las pantallas de Terreno).
4. Agregar las entradas de Terreno a `src/config/nav-items.ts`.
5. Reemplazar el selector de rol dev por el usuario real (`useCurrentUser`). Login vía `LoginView`.

## 4. Bloqueante / pendiente de coordinación con el equipo

- **Schema de dominio + `Equipo`:** el `schema.prisma` de Benjamín es **solo auth** y
  prohíbe modelos de dominio; **Amin aún no subió `Equipo`** ni el schema de dominio en
  ninguna rama. Sin eso, mis tablas no se pueden migrar. → **Definir con el equipo**: dónde
  vive el schema de dominio (¿mismo `schema.prisma`? ¿schema-folder de Prisma?) y quién/ cuándo
  define `Equipo`. Apenas exista, se ejecutan los pasos §3.
- **Setup local:** el back ahora requiere **Docker** (`docker compose up -d` → Postgres 5433),
  `.env` desde `.env.example` con `BETTER_AUTH_SECRET` (`openssl rand -base64 32`),
  `npx prisma migrate dev` + `npm run db:seed`. En máquinas sin Docker no arranca el back.

## 5. Estado actual de esta rama

- El código de Terreno (back + front, UI mobile, 4 dominios, subida de fotos) sigue
  **intacto y funcionando** sobre la base provisional (SQLite + guard stub) — sirve para la
  demo/capturas mientras se coordina la integración real.
- PRs abiertos: `smi-backend#1`, `smi-frontend#1`.
