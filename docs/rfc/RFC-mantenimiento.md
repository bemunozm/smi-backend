# RFC — Dominio **Mantenimiento** · Slice **Órdenes de Trabajo + Bitácora** (SMI)

| Campo | Valor |
|---|---|
| **Autor** | Joaquín |
| **Bloque** | #3 — Mantenimiento |
| **Slice de este RFC** | **Órdenes de Trabajo (OT) + Bitácora de Intervención (con descuento de stock)** |
| **Diferido a Fase 2** | Motor Preventivo, Actividades/Tareas |
| **Estado** | `Draft` — para comentarios del equipo |
| **Fecha** | 2026-08-04 |
| **Depende de** | **Sprint 0 mergeado en `main`** (bloqueante — ver §1) |
| **Coordina con** | Amin (Inventario + `schema.prisma`), Benjamín (Núcleo: auth, roles, dashboard) |

> **Regla de la guía (§9):** *"Nadie empieza su bloque hasta que Sprint 0 esté mergeado en `main`."* Este RFC se redacta **antes** de tener Sprint 0 para llegar con el diseño y los contratos ya acordados el día que la base esté lista. Nada de lo aquí propuesto se implementa todavía.

---

## 1. Contexto y estado actual del código

Exploración completa de ambos repos al 2026-08-04:

- **`smi-backend`** — NestJS 11 en scaffolding. Solo `AppModule` + `AppController`/`AppService` por defecto. **No existe** Prisma, `schema.prisma`, `PrismaModule`, `class-validator`, Better Auth, guard de sesión, decorador `@Roles`, `ValidationPipe`, prefijo global `/api`, interceptor de respuesta `{ data, message }` ni exception filter. Todo eso es Sprint 0.
- **`smi-frontend`** — Vite 8 + React 19 + Tailwind v4 en scaffolding. Un único `App.tsx` sin router. **Sí** trae la paleta de colores lista en `index.css` (tokens `@theme inline`, variantes light/`.dark`, `--primary: #2e67ff`, `--radius: 1.3rem`, tokens `sidebar-*` y `chart-*`). **No existe** HeroUI, TanStack Query, Zustand, React Hook Form, Zod, `@hookform/resolvers`, axios, router, `shared/`, `modules/` ni `routes.tsx`.
- **Repos separados**, no monorepo. La guía asume `smi/apps/{api,web}`; la unificación (o no) la define Sprint 0.

**Conclusión:** no hay código de dominio que reutilizar ni duplicar todavía. Este RFC define **qué construir**, **en qué capa**, y **qué contratos** cerrar con los otros dueños de dominio para arrancar en cuanto Sprint 0 esté en `main`.

---

## 2. Principio arquitectónico aplicado

Se respeta **dominios, no roles** (guía §1):

- Mantenimiento es **un módulo NestJS por dominio** (`modules/mantenimiento/`) y **una carpeta de dominio en el front** (`modules/mantenimiento/`). Sin carpetas por rol.
- Los roles son una **capa liviana de permisos**: cada endpoint declara `@Roles(...)`. No se sobre-invierte ahora (guía §7).
- El menú del front puede mostrar/ocultar vistas según rol, pero el código vive por dominio.

---

## 3. Alcance

### ✅ En alcance (este slice)
1. **Órdenes de Trabajo (OT):** bandeja con badges de estado, ficha/detalle, crear, asignar mantenedor, cambiar estado.
2. **Bitácora de Intervención:** registrar intervención sobre una OT, con **insumos usados → descuento de stock** (demo "antes/después"). Bitácora inmutable al cerrar (`soloLectura`).

### 🕓 Diferido a Fase 2 (mismo bloque, otro RFC/PR)
- **Motor Preventivo:** umbrales por horómetro + alerta automática. Requiere el contrato del evento `horometro.updated` con Alexander (Terreno).
- **Actividades/Tareas:** crear/asignar/seguir estado (origen manual, hallazgo o preventivo).

> Se difieren para reducir superficie y dependencias, y porque OT + Bitácora es la captura más potente para el PPT (guía §13: *"bitácora con insumos usados → descuenta stock antes/después"*). Aun así, **sus tablas se proponen en el `schema.prisma` de una vez** en Sprint 0 (§4), para no tocar la zona sensible dos veces.

### 🚫 Fuera de alcance (otros dueños)
- Descuento de stock **implementado dentro** de Inventario → **Amin** expone la función; nosotros la consumimos (§5.1).
- Auth, guard de sesión y decorador `@Roles` → **Benjamín** (Sprint 0). Nosotros solo los **usamos**.
- Envío real de notificaciones y el Dashboard → **Benjamín**. Este slice como mucho registra `Notificacion(OT_ASIGNADA)` (opcional).

---

## 4. Modelo de datos (propuesta para ratificar en Sprint 0 con Amin)

> `schema.prisma` es **zona sensible** y su dueño es **Amin** (guía §11). Esto es una **propuesta** de las entidades del dominio Mantenimiento; los nombres/campos se cierran entre los 4 en Sprint 0. Marco en **negrita** lo que se aparta o extiende la tabla base de la guía (§6).
>
> **Estrategia:** las 5 tablas del dominio se declaran de una vez en Sprint 0. Este slice **implementa lógica/endpoints solo para `OrdenTrabajo`, `Intervencion` e `IntervencionInsumo`**. `UmbralMantenimiento` y `Actividad` quedan declaradas pero sin endpoints hasta Fase 2.

```prisma
enum EstadoOT {
  PENDIENTE
  ASIGNADA
  EN_PROCESO
  COMPLETADA
  CANCELADA
}

enum TipoOT {
  CORRECTIVA
  PREVENTIVA
}

enum OrigenOT {
  MANUAL
  PREVENTIVO
  HALLAZGO
}

// ---- Slice actual: OT + Bitácora ----

model OrdenTrabajo {
  id            String        @id @default(cuid())
  equipoId      String                                   // → Equipo (Flota, Amin)
  asignadoAId   String?                                  // → user.id (Better Auth)
  tipo          TipoOT        @default(CORRECTIVA)
  origen        OrigenOT      @default(MANUAL)
  estado        EstadoOT      @default(PENDIENTE)
  descripcion   String?
  intervenciones Intervencion[]
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
}

model Intervencion {
  id             String               @id @default(cuid())
  ordenId        String                                  // → OrdenTrabajo
  orden          OrdenTrabajo         @relation(fields: [ordenId], references: [id])
  detalle        String
  soloLectura    Boolean              @default(false)    // inmutable al cerrar (bitácora)
  realizadaPorId String?                                 // → user.id (mantenedor)
  insumos        IntervencionInsumo[]                    // insumos consumidos (demo antes/después)
  fecha          DateTime             @default(now())
}

// **NUEVA tabla** — no está en §6. Necesaria para "bitácora con insumos usados".
// Se ratifica con Amin porque toca la relación con Inventario.
model IntervencionInsumo {
  id             String       @id @default(cuid())
  intervencionId String
  intervencion   Intervencion @relation(fields: [intervencionId], references: [id])
  insumoId       String                                  // → Insumo (Inventario, Amin)
  cantidad       Int
}

// ---- Fase 2: declaradas ahora, sin endpoints en este slice ----

model UmbralMantenimiento {
  id             String  @id @default(cuid())
  tipoEquipo     String
  tipoMantencion String
  umbralHoras    Int
}

model Actividad {
  id          String   @id @default(cuid())
  asignadoAId String?
  origenTipo  String   @default("MANUAL")   // enum en Fase 2
  hallazgoId  String?                        // → Hallazgo (Terreno)
  equipoId    String?                        // → Equipo (Flota)
  estado      String   @default("PENDIENTE") // enum en Fase 2
  descripcion String?
  fecha       DateTime @default(now())
}
```

**Decisiones abiertas para Sprint 0:**
- **`IntervencionInsumo`** es tabla nueva (no está en §6). Alternativa: reutilizar `MovimientoInventario` como registro de consumo y no crear join. Recomendación: **crear el join** para tener la relación explícita bitácora↔insumo; `MovimientoInventario` sigue siendo la fuente de verdad del stock.
- Nombre/valores de los enums (`EstadoOT`, etc.) — ratificar con el grupo.
- IDs `cuid()` vs `uuid()` vs `autoincrement()` — que lo defina Amin de forma uniforme para todas las tablas.

---

## 5. Puntos de cruce entre dominios (los contratos, lo más importante)

### 5.1 Descuento de stock — con **Inventario (Amin)** · **EN ALCANCE**

**Problema:** al registrar una Intervención con insumos, hay que restar stock y dejar rastro (`MovimientoInventario`), de forma **atómica**.

**Contrato propuesto (dueño = Amin, lo consume Mantenimiento):**

```ts
// Expuesto por InventarioModule (Amin). Corre dentro de una transacción Prisma.
interface RegistrarSalidaInput {
  insumoId: string;
  cantidad: number;
  origen: 'INTERVENCION';      // valor del enum origen de MovimientoInventario
  responsableId: string;       // user.id del mantenedor
  referenciaId?: string;       // intervencionId, para trazabilidad
}
InventarioService.registrarSalida(input, tx): Promise<MovimientoInventario>
```

- La creación de la Intervención + N descuentos corren en **un solo `prisma.$transaction`** → todo-o-nada.
- **A acordar con Amin:** la firma exacta, cómo se pasa la transacción (`tx` de Prisma), el valor de `origen`, y qué pasa si `cantidad > stock` (rechazar con error de dominio → `409`/`422`).
- **Regla de la guía:** Mantenimiento **no** escribe directo sobre `Insumo.stock`; siempre vía la función de Inventario.

### 5.2 Roles/permisos — con **Núcleo (Benjamín)** · **EN ALCANCE**

Solo **declaramos** qué roles acceden a cada endpoint con `@Roles(...)`. El guard y el decorador los provee Sprint 0.

### 5.3 Motor Preventivo ← Horómetro — con **Terreno (Alexander)** · **FASE 2**

Cuando se difiera a Fase 2: evento desacoplado `horometro.updated` (`@nestjs/event-emitter`) emitido por Terreno al cerrar la lectura; Mantenimiento escucha con `@OnEvent` y evalúa umbrales. Terreno no conoce a Mantenimiento. Se detalla en el RFC de Fase 2.

---

## 6. Diseño de Backend (NestJS) — slice OT + Bitácora

Módulo por dominio: `.../modules/mantenimiento/` (ubicación exacta según decida Sprint 0). Estructura sugerida para este slice:

```
modules/mantenimiento/
├─ mantenimiento.module.ts
├─ ordenes/           # OT: controller, service, dto/
├─ intervenciones/    # bitácora + consumo de insumos
└─ dto/               # DTOs con class-validator
```

**Endpoints (REST, prefijo `/api`, respuestas `{ data, message }`, DTOs con `class-validator`):**

| Método | Ruta | Descripción | `@Roles` sugerido |
|---|---|---|---|
| GET | `/api/mantenimiento/ordenes` | Bandeja de OT (filtros: estado, equipo) | ADMIN, SUPERVISOR, MANTENEDOR |
| GET | `/api/mantenimiento/ordenes/:id` | Ficha de OT + bitácora | ADMIN, SUPERVISOR, MANTENEDOR |
| POST | `/api/mantenimiento/ordenes` | Crear/asignar OT | ADMIN, SUPERVISOR |
| PATCH | `/api/mantenimiento/ordenes/:id` | Cambiar estado / reasignar | ADMIN, SUPERVISOR, MANTENEDOR |
| POST | `/api/mantenimiento/ordenes/:id/intervenciones` | Registrar intervención (+ insumos → descuenta stock, transacción) | MANTENEDOR |
| GET | `/api/mantenimiento/ordenes/:id/intervenciones` | Bitácora de la OT | ADMIN, SUPERVISOR, MANTENEDOR |

- **DTOs:** `CreateOrdenTrabajoDto`, `UpdateOrdenTrabajoDto`, `CreateIntervencionDto` (incluye `insumos: { insumoId, cantidad }[]`) — todos con `class-validator`.
- **Transacción** de intervención+stock en `intervenciones.service.ts` (§5.1).

---

## 7. Diseño de Frontend (React + Vite + HeroUI) — slice OT + Bitácora

Carpeta de dominio: `modules/mantenimiento/`. Reutiliza `shared/` (layout, api client axios, store Zustand de auth) que deja Sprint 0.

**Patrón estándar obligatorio (guía §3.1):**
- **Leer** → `useQuery` (TanStack Query). Nada de `useEffect` + axios manual.
- **Crear/editar** → `useMutation` + invalidar la query afectada.
- **Formularios** → React Hook Form + `zodResolver(esquema)`. Esquemas Zod en `modules/mantenimiento/schemas.ts`.
- **UI** → componentes HeroUI; estilos puntuales con Tailwind. Aprovechar el MCP/skills de HeroUI.

**Pantallas (mapea a las capturas de la demo, guía §13):**

| Pantalla | Componentes clave | Datos |
|---|---|---|
| **Bandeja de OT** | Tabla HeroUI + `Chip` de estado (badges por `EstadoOT`) | `useQuery(['ordenes'])` |
| **Ficha de OT** | Detalle + timeline de intervenciones | `useQuery(['orden', id])` |
| **Crear OT** | `Modal` + form RHF/Zod (equipo, mantenedor) | `useMutation` → invalida `['ordenes']` |
| **Registrar intervención** | Form RHF/Zod con selector de insumos + cantidades; muestra **stock antes/después** | `useMutation` → invalida `['orden', id]` y queries de inventario |

- Rutas nuevas se agregan a `routes.tsx` **avisando** (archivo compartido, guía §11).
- La visibilidad de menú por rol usa el store de auth de `shared/`.

---

## 8. Plan de implementación por fases (slice)

Cada fase se delega a un **agente especializado** (`backend` / `frontend`), se **revisa** con `reviewer`, y se cierra con commits Conventional + PR a `main`. Ver metodología en §10.

| Fase | Descripción | Agente | Depende de |
|---|---|---|---|
| **F0** | **Sprint 0 mergeado** (Prisma, auth, stack front, `shared/`). *No es de Joaquín.* | — (Benjamín) | — |
| **F1** | Cerrar contrato de stock con Amin (§5.1) + ratificar entidades §4 en `schema.prisma` | — (coordinación) | F0 |
| **F2** | Backend: módulo `mantenimiento` + CRUD **Órdenes de Trabajo** + DTOs + `@Roles` + seed OT | `backend` | F1 |
| **F3** | Backend: **Bitácora/Intervención** + integración descuento de stock (transacción, §5.1) | `backend` | F2 + Amin listo |
| **F4** | Frontend: bandeja OT + ficha + crear (useQuery/useMutation/RHF+Zod, HeroUI) | `frontend` | F2 |
| **F5** | Frontend: bitácora + intervención con insumos (stock antes/después) | `frontend` | F3, F4 |
| **F6** | Seed del dominio, pulido, capturas para el PPT | ambos | todas |

**Fase 2 (post-slice, otro RFC/PR):** Motor Preventivo (umbrales + listener `horometro.updated`) y Actividades/Tareas.

Las fases backend (F2–F3) y las de front (F4–F5) pueden solaparse una vez que F2 expone endpoints.

---

## 9. Testing y Definition of Done (demo)

Por cada fase (guía §16):
- Pantalla ordenada y presentable, con **datos reales** desde la API.
- Flujo principal **sin errores en consola**.
- DTOs validados (`class-validator`); respuestas `{ data, message }`.
- Mergeada en `main` vía **PR revisado** por ≥1 compañero.
- Al menos **una captura** lista para el PPT.
- Tests mínimos: `jest` en la transacción de stock (crear intervención + descuento).

---

## 10. Metodología de ejecución (cuando F0 esté listo)

1. **Exploración complementaria** del Inventario de Amin (función de stock) para escribir en la capa correcta sin duplicar.
2. **Plan mode** para formalizar cada fase antes de tocar código.
3. **Delegar** la fase a un agente especializado (`backend`/`frontend`).
4. **Revisar** la implementación del agente (integridad, patrones §3.1, DTOs, `@Roles`, separación por dominio, cuidado con `schema.prisma`).
5. **Commits** Conventional Commits agrupados por archivo lógico.
6. **Rama** `feat/mantenimiento/<descripcion>` → **PR a `main`** con ≥1 revisor.
7. **Revisión final** exhaustiva: arquitectura por dominio (no por rol), reutilización (`shared/`, HeroUI), separación de capas, permisos livianos vía `@Roles`, y alineación con este RFC.

**Convenciones (guía §10):**
- Rama: `feat/mantenimiento/<descripcion>` (también `fix/…`, `chore/…`, `docs/…`).
- Commits: `feat(mantenimiento): ...`, `fix(mantenimiento): ...`, `chore(mantenimiento): ...`.
- Nada de push directo a `main`.

---

## 11. Riesgos y decisiones abiertas

| # | Riesgo / decisión | Mitigación |
|---|---|---|
| R1 | Sprint 0 aún no mergeado — todo el bloque está bloqueado | Este RFC + contrato §5.1 listos para arrancar sin fricción |
| R2 | `IntervencionInsumo` es tabla nueva fuera de §6 | Ratificar con Amin en Sprint 0 antes de codear |
| R3 | Firma de `registrarSalida` depende de Amin | Acordar en F1; la transacción compartida es el punto delicado |
| R4 | `stock < cantidad` en intervención | Definir error de dominio (409/422) y feedback en el form |
| R5 | Repos separados vs monorepo | Depende de Sprint 0; RFC agnóstico a la ubicación |

---

## 12. Preguntas para el equipo (comentarios del RFC)

1. **Amin:** ¿ok con `IntervencionInsumo` como join, y con la firma de `registrarSalida(input, tx)` corriendo en la transacción de la intervención? ¿Valor de `origen` = `'INTERVENCION'`? ¿Declaramos las 5 tablas del dominio de una vez en Sprint 0?
2. **Benjamín:** ¿guard + `@Roles` disponibles en Sprint 0? ¿Registramos `Notificacion(OT_ASIGNADA)` en este slice o lo dejamos para Fase 2?
3. **Todos:** ¿enums y estrategia de IDs uniformes en `schema.prisma`?
