# Diseño — Scaffolding "Operación en Terreno" (bloque de Alexander)

**Fecha:** 2026-08-04
**Autor:** Alexander Farias
**Proyecto:** SMI — Sistema de Mantenimiento e Inventario (Evonova)
**Repos:** [smi-backend](https://github.com/bemunozm/smi-backend) · [smi-frontend](https://github.com/bemunozm/smi-frontend)

---

## 1. Contexto y estado actual

El proyecto SMI se reparte por dominios (guía `GUIA_DESARROLLO_SMI.md`). A Alexander le corresponde el
bloque **Operación en Terreno**: Combustible, Horómetro, Trabajos Extraordinarios y Hallazgos.

Estado real de los repos al iniciar (ambos solo en `main`, sin otras ramas ni PRs):

- **smi-backend**: NestJS 11 pelado (1 commit `scaffold nestjs project`). Sin Prisma, sin Better Auth,
  sin docker, sin módulos de dominio, sin `common/`.
- **smi-frontend**: React 19 + Vite 8 + Tailwind v4, con una paleta de colores ya definida en `src/index.css`.
  `App.tsx` es un placeholder. Sin HeroUI, TanStack Query, Zustand, RHF, Zod, axios ni router.

**Divergencia con la guía:** el equipo usó **dos repos separados** en vez del monorepo `smi/apps/api`+`apps/web`
descrito en §8. Consecuencia: el front habla con el back **cross-origin**, así que hace falta CORS con
`credentials` (relevante cuando llegue Better Auth por cookies).

**Sprint 0 (base compartida) NO está hecho.** La guía dice "nadie empieza su bloque hasta que Sprint 0 esté
mergeado", pero ese Sprint 0 es responsabilidad del equipo (schema.prisma → Amin; núcleo/auth → Benjamín).

## 2. Decisiones de alcance (acordadas)

1. **Alcance:** solo scaffolding del bloque de Alexander (Operación en Terreno). No construimos el Sprint 0
   completo del equipo ni dominios de otros.
2. **Integración:** el bloque debe **correr HOY**. Como la base compartida no existe, incluimos una **base
   mínima provisional** (claramente marcada como desechable) que se reemplaza cuando aterrice el Sprint 0 real.
3. **Base de datos:** **SQLite vía Prisma** para dev local (no hay Docker/Postgres en la máquina). Prisma abstrae
   el motor → migrar al Postgres del equipo después es cambiar `provider` + connection string.
   - SQLite no soporta enums de Prisma: `criticidad`, `estado`, `turno` van como `String`, validados con
     Zod (front) y class-validator (back) mediante uniones de literales. Amin los convierte a enums al integrar.
4. **Git:** trabajo local en ramas `feat/terreno/...` con Conventional Commits. **Sin push** a los repos del
   equipo (main protegido, repo compartido). Alexander decide el PR. La base provisional no debería entrar a un
   PR compartido: se borra cuando exista el Sprint 0 real.
5. **Ubicación:** repos clonados en `c:\Users\123\Desktop\ISM\smi-backend` y `...\smi-frontend`.

## 3. Backend (smi-backend, NestJS 11)

### 3.1 Base provisional (marcada `// PROVISIONAL — reemplazar con Sprint 0`)

- `prisma/schema.prisma`: datasource SQLite + generator client. Modelos:
  - `Equipo` (placeholder mínimo, dueño real = Amin): `id, codigo, tipo, marca, modelo, estado,
    horometroActual, kilometrajeActual`.
  - Los 4 modelos de Terreno (§3.3).
  - `operadorId` / `responsableId` como `String` (referencian el `user.id` de Better Auth futuro; sin FK aún).
- `src/prisma/prisma.service.ts` + `prisma.module.ts`: `PrismaService` en módulo global.
- `src/common/`:
  - `decorators/roles.decorator.ts` → `@Roles(...roles)`.
  - `guards/roles.guard.ts` → **stub**: lee el rol desde un header de dev (`x-dev-role`) y valida contra
    `@Roles`. Reemplazable por el guard de sesión de Better Auth.
  - `filters/http-exception.filter.ts` → forma de error consistente.
  - `interceptors/transform.interceptor.ts` → envuelve respuestas OK en `{ data, message }` (§7).
- `src/main.ts`: prefijo global `/api`, CORS (`origin: http://localhost:5173`, `credentials: true`),
  `ValidationPipe` global (`whitelist`, `transform`), filtro de excepciones global.
- `.env` + `.env.example`: `DATABASE_URL="file:./dev.db"`, `PORT=3000`.
- `prisma/seed.ts`: datos de ejemplo (§5).

### 3.2 Módulo de dominio `src/modules/terreno/`

`terreno.module.ts` agrupa 4 submódulos: `combustible/`, `horometro/`, `trabajos-extra/`, `hallazgos/`.
Cada submódulo:

- `*.controller.ts`: `GET /` (lista), `GET /:id`, `POST /`, `PATCH /:id`.
- `*.service.ts`: CRUD Prisma + lógica de dominio.
- `dto/create-*.dto.ts`, `dto/update-*.dto.ts`: class-validator.
- `@Roles('SUPERVISOR', 'ADMIN')` en escritura (Supervisor registra, Admin ve/gestiona — §4).

Rutas (top-level por subdominio, como los ejemplos de §7):
`/api/combustible`, `/api/horometro`, `/api/trabajos-extra`, `/api/hallazgos`.

### 3.3 Entidades y lógica de dominio

- **RegistroCombustible** `(id, equipoId, litros, fotoUrl, rendimiento, fecha)`
  - `rendimiento` calculado en el service (p.ej. `delta_horometro / litros` si hay lectura previa; si no, acepta
    el valor provisto). `fotoUrl` = string (URL/data-URL); sin upload real.
- **RegistroHorometro** `(id, equipoId, operadorId, turno, valorInicial, valorFinal, fecha)`
  - Historial de lecturas por turno. Al **cerrar** turno (llega `valorFinal`): actualiza
    `Equipo.horometroActual = valorFinal`.
  - **Punto de extensión** (TODO/evento) para el motor preventivo de Joaquín — aquí se dispararía el umbral.
    Alexander solo deja el gancho; el lado de mantenimiento es de Joaquín.
- **TrabajoExtraordinario** `(id, equipoId, cliente, horasMaquina, tonelaje, tarifa, monto, fotoUrl)`
  - `monto = horasMaquina * tarifa` calculado server-side (`tonelaje` informativo).
- **Hallazgo** `(id, equipoId, descripcion, criticidad, estado, fotoUrl)`
  - `criticidad ∈ {BAJA, MEDIA, ALTA, CRITICA}` (requerida). `estado ∈ {ABIERTO, EN_PROCESO, CERRADO}`,
    default `ABIERTO`.

## 4. Frontend (smi-frontend, React 19 + Vite 8 + Tailwind v4)

### 4.1 Base provisional en `src/shared/`

- `providers/`: `QueryClientProvider` (TanStack), `HeroUIProvider`, router.
- `api/client.ts`: instancia axios (`baseURL: import.meta.env.VITE_API_URL` → `http://localhost:3000/api`,
  `withCredentials: true`). En dev, inyecta `x-dev-role` desde el store para el guard stub.
- `store/auth.store.ts`: Zustand con un **selector de rol de dev** (ADMIN/SUPERVISOR/...) para que la capa de
  permisos y el menú-por-rol funcionen antes de Better Auth. Se reemplaza por `useSession()` después.
- `layout/`: `AppLayout` con menú lateral (sección "Terreno" con las 4 pantallas; placeholders para otros dominios).
- `routes.tsx`: rutas de las 4 pantallas + landing.
- Dependencias a instalar: `@heroui/react`, `@tanstack/react-query`, `zustand`, `react-hook-form`, `zod`,
  `@hookform/resolvers`, `axios`, `react-router`.
- `.env`: `VITE_API_URL=http://localhost:3000/api`.

### 4.2 Módulo de dominio `src/modules/terreno/`

4 sub-carpetas (`combustible`, `horometro`, `trabajos-extra`, `hallazgos`), cada una siguiendo **exactamente el
patrón §3.1** — es la plantilla que el resto del equipo copiará:

- `schemas/*.schema.ts`: esquemas Zod (validan el form con `zodResolver` **y** tipan la respuesta de la API).
- `api/*.api.ts`: funciones que usan el cliente axios (list, get, create, update).
- `hooks/*.ts`: `useQuery` / `useMutation` con query keys + invalidación.
- `pages/*.tsx`: las pantallas de la demo (§13):
  1. **Combustible**: lista + form (RHF+Zod) para registrar carga con foto → muestra `rendimiento`.
  2. **Horómetro**: lista + form para registrar lectura por turno.
  3. **Trabajos extra**: form horas/tonelaje/tarifa → muestra `monto`; lista.
  4. **Hallazgos**: form crear hallazgo con `criticidad` (select) + badges de `estado`; lista.

## 5. Seed (datos de ejemplo)

`prisma/seed.ts`: ~6 equipos con estados variados + registros de Alexander (horómetro, combustible, 2-3
hallazgos, 1-2 trabajos extra) para que las pantallas no salgan vacías. `operadorId`/`responsableId` como ids
placeholder tipo `"user-operador-1"`.

## 6. Estrategia de Git

- Rama backend: `feat/terreno/scaffolding` (y sub-ramas `feat/terreno/registro-combustible`, etc. si se prefiere
  granular). Rama frontend equivalente.
- Conventional Commits (`feat(terreno): ...`, `chore(api): ...`).
- **Sin push** hasta que Alexander lo decida. La base provisional queda separada/marcada para poder descartarla.

## 7. Fuera de alcance (YAGNI / respeto de ownership)

- Better Auth real (usamos stub de rol).
- Upload real de archivos (`fotoUrl` es string).
- Dominios de otros: inventario, mantenimiento, actividades, dashboard, notificaciones.
- El lado de mantenimiento del motor preventivo (solo dejamos el gancho en Horómetro).
- CI/CD, deploy, PWA offline.

## 8. Riesgos

- **HeroUI ↔ Tailwind v4**: HeroUI (ex-NextUI) apuntaba a Tailwind v3; el front ya está en Tailwind v4. Primer
  paso de implementación: verificar compatibilidad (context7/docs oficiales). Si no encaja limpio, fallback a
  Tailwind puro respetando la paleta existente en `index.css`, manteniendo el resto del patrón §3.1 intacto.
- **SQLite vs Postgres**: sin enums nativos ni algunos tipos. Mitigado usando `String` + validación; conversión
  trivial al integrar con el schema del equipo.
- **Integración futura**: al llegar el Sprint 0, hay que reemplazar los stubs (PrismaService/Equipo real, guard de
  Better Auth, `useSession`). Todo lo provisional queda marcado con comentarios `PROVISIONAL`.

## 9. Definition of Done (para este scaffolding)

- `npm run start:dev` (back) y `npm run dev` (front) levantan sin errores.
- Las 4 pantallas muestran datos reales desde la API (seed) y permiten crear registros.
- Flujo principal sin errores en consola.
- Cada pantalla sirve como plantilla del patrón §3.1.
- Al menos una captura por pantalla lista para el PPT.
