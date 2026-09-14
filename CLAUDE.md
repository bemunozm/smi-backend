# SMI Backend — Guía de arquitectura (para agentes de IA)

API REST del **Sistema de Mantenimiento e Inventario (SMI)**. Este archivo define la arquitectura, convenciones y el patrón a seguir. **Léelo antes de escribir código.** Sigue estas reglas exactamente; sobre-escriben cualquier comportamiento por defecto.

## Stack (decidido, no cambiar sin acuerdo del equipo)
- **NestJS 11** + **TypeScript strict** (`strict: true`, prohibido `any`).
- **Prisma 6** (NO 7 — la 7 rompe el patrón `url = env("DATABASE_URL")`) + **PostgreSQL 16** (local vía Docker).
- **Better Auth** (`better-auth`) + **`@thallesp/nestjs-better-auth`** para la integración NestJS. Auth por **sesión/cookies**, plugin `admin` para roles.
- Validación con **class-validator** (DTOs). `ValidationPipe` global activo.

## Principio de arquitectura: un módulo Nest por dominio
El sistema se organiza por **dominios funcionales**, no por roles. Los roles (`ADMIN | SUPERVISOR | MANTENEDOR | OPERADOR`) son una capa de permisos liviana, no módulos.

```
src/
├── auth/              # Núcleo: config de Better Auth, roles, access-control (transversal)
│   ├── auth.ts        # betterAuth({...}) — prismaAdapter + emailAndPassword + admin plugin
│   ├── roles.ts       # ROLES (fuente única de los 4 valores)
│   └── access-control.ts  # ac/roles custom del plugin admin
├── common/            # Compartido (NO es de nadie en particular)
│   ├── prisma/        # PrismaService (singleton, @Global) — ÚNICA instancia de PrismaClient
│   ├── config/        # env.ts: única fuente de env, validada fail-fast al boot
│   └── filters/       # filtro global de errores → forma { data, message }
├── users/             # Dominio Usuarios (Núcleo) — plantilla de referencia de un módulo
│   ├── users.module.ts
│   ├── users.controller.ts
│   ├── users.service.ts
│   └── dto/
├── health/            # GET /api/health (público)
├── main.ts            # bootstrap: bodyParser:false, CORS, prefijo /api, shutdown hooks
└── app.module.ts      # importa AuthModule.forRoot({auth}) + los módulos de dominio
prisma/
├── schema.prisma      # SOLO tablas de auth por ahora (ver abajo)
├── migrations/
└── seed.ts            # 1 usuario por rol
```

**Trabaja dentro de la carpeta de tu dominio.** Archivos compartidos (`app.module.ts`, `common/`, `prisma/schema.prisma`) se editan avisando al equipo.

## schema.prisma — zona sensible
Contiene las tablas de Better Auth (`user`, `session`, `account`, `verification`) **y los modelos de todos los dominios ya integrados** (Equipo, Insumo, MovimientoInventario, RegistroCombustible, RegistroHorometro, TrabajoExtraordinario, Hallazgo, OrdenTrabajo, Intervencion, UmbralMantenimiento, Actividad, Notificacion). El campo `role` (String, default `OPERADOR`) vive en `user`. **NO crear una tabla `Usuario` propia** — se referencia `user.id` de Better Auth. Todo cambio al schema va por **rama corta + migración Prisma versionada + PR** (avisar al equipo; ver `CONTRIBUTING.md`).

## Cómo agregar un módulo de dominio (sigue `users/` como plantilla)
1. `src/<dominio>/<dominio>.module.ts` + `.controller.ts` + `.service.ts` + `dto/`.
2. El **controller** expone REST bajo `/api/<dominio>`, verbos `GET/POST/PATCH/DELETE`.
3. Toda respuesta de éxito devuelve **`{ data, message }`**. Los errores los formatea el filtro global — lanza excepciones Nest (`NotFoundException`, `ConflictException`, etc.).
4. **DTOs con class-validator** en cada endpoint que reciba body/params.
5. Acceso a BD: **inyecta `PrismaService`** (de `common/prisma`). **NUNCA** hagas `new PrismaClient()` — habría dos pools.
6. **Protección por rol**: `@Roles(['ADMIN'])` de `@thallesp/nestjs-better-auth` a nivel de controller o método. El `AuthGuard` global ya exige sesión (deny-by-default); `@Roles` restringe por rol. Declara qué roles acceden a tus endpoints.
7. Registra tu módulo en `app.module.ts`.
8. Sesión del request: decorador `@Session()` (`UserSession`) de la librería.

## Autenticación (ya montada, no reinventar)
- Handler de Better Auth en `/api/auth/*` (login/logout/sesión). En el front se consume con `useSession()` del cliente — **el backend no emite JWT manuales**.
- `AuthGuard` global **deny-by-default**: toda ruta exige sesión salvo `@AllowAnonymous()`.
- `disableSignUp: true` → no hay registro público; los usuarios se crean vía el módulo `users` (que usa `auth.api` del plugin admin) o el seed.
- Roles: se comparan como string simple (`session.user.role`). El `ac`/`roles` custom del plugin admin (`auth/access-control.ts`) mapea los 4 roles; `ADMIN` tiene los permisos de gestión de usuarios.

## Convenciones de código (obligatorias)
- TypeScript strict. **Prohibido `any`** → usa `unknown` + type guards.
- **Named exports** (no `export default`).
- Nada de `console.log` para errores → usa el `Logger` de Nest.
- **No hardcodear** secretos/URLs/puertos → todo por `env.ts` (que lee de `@nestjs/config`). `.env` está gitignored; hay `.env.example`.
- Respuestas `{ data, message }`. Fechas serializadas ISO.

## Setup local
```bash
docker compose up -d                 # PostgreSQL (contenedor smi-postgres, puerto host 5433)
cp .env.example .env                 # ajustar; genera BETTER_AUTH_SECRET con: openssl rand -base64 32
npm install
npx prisma migrate dev
npm run db:seed                      # 4 usuarios: <rol>@smi.local / Smi123456!  (solo dev)
npm run start:dev                    # API en http://localhost:3000  (rutas bajo /api)
```
Env clave: `DATABASE_URL`, `BETTER_AUTH_SECRET` (≥32 chars), `BETTER_AUTH_URL`, `FRONTEND_URL`, `PORT`.

## Flujo de trabajo y Git
La **metodología completa** (regla de oro, Producto→RFC→Desarrollo, review cruzado, Definition of Done de producción, tableros) vive en **`CONTRIBUTING.md`** — léela antes de tomar una tarea. Esencial:
- **Regla de oro:** sin **ticket de Producto** + **RFC aprobado**, no se desarrolla.
- `main` estable y **protegida**: PR obligatorio + **review del otro dev** + CI verde. **Nunca push directo a main.**
- Rama por funcionalidad: `feat/<dominio>/<descripcion>` (`fix/…`, `chore/…`, `docs/…`). El cuerpo del PR referencia `PROD·RFC·DEV`.
- Commits: `tipo(contexto): descripción` en **inglés**, imperativo, ≤100 chars, sin mayúscula inicial ni punto final. **Sin co-autoría de IA.**

## Convenciones de nombres e idioma
**El código y la base de datos van en INGLÉS** (estándar universal). Español SOLO para textos visibles al usuario final (labels/mensajes de UI) y comentarios. Aplica a: modelos y tablas, columnas, enums, funciones, variables, tipos, DTOs, endpoints REST, nombres de archivo, ramas y commits.
- Prisma models / tipos / clases / componentes React: `PascalCase` (`Equipment`, `StockMovement`).
- Campos de model, variables y funciones: `camelCase` (`internalCode`, `currentHourmeter`).
- Tablas y columnas Postgres: `snake_case` vía `@@map`/`@map` (`equipment`, `internal_code`).
- Enums: nombre `PascalCase`, valores `UPPER_SNAKE` (`EquipmentStatus { OPERATIONAL }`).
- Constantes `UPPER_SNAKE`; archivos `kebab-case` (`equipment.service.ts`); endpoints `kebab-case` (`/inventory/items`).

**Migración gradual (el código actual está en español, herencia de la demo):** cada dueño de módulo **renombra su dominio a inglés al tocarlo**; todo lo NUEVO nace en inglés. Se acepta un híbrido temporal hasta completar. Meta: 100% inglés. En la S1, el modelo de datos (RFC T01) ya se diseña en inglés.

## Deuda técnica y seguridad (ver `SECURITY-NOTES.md`)
Rate limiting, bind de Postgres a `127.0.0.1`, helmet, cookies seguras, TTL de sesión, auth en `/uploads`, índices `@@index([equipoId])` faltantes. **El proyecto va a producción → ya NO son diferibles**: se saldan en la Fase 0 (RFC de CI/CD + hardening). No introducir código nuevo que dependa de estas deudas.

## Prohibiciones
- ❌ `any` en TypeScript · ❌ `console.log` para errores · ❌ `new PrismaClient()` suelto (usa `PrismaService`)
- ❌ Hardcodear credenciales/URLs · ❌ push directo a `main` · ❌ co-autoría de IA en commits
- ❌ Insertar/actualizar credenciales o rol con Prisma crudo → usa `auth.api` de Better Auth
- ❌ Modelos de dominio en `schema.prisma` sin avisar al equipo
