# Flota + Inventario — reconciliación del `schema.prisma` y dominio de Amin

**Fecha:** 2026-08-05 · **Autor:** Amin · **Bloque:** #1 Flota + Inventario

Nota de handoff para el equipo. Reemplacé el `Equipo` **PROVISIONAL** de Alexander
por el modelo real de Flota y agregué el dominio de Inventario completo. Acá está
qué cambió, qué tiene que tocar cada uno y cómo levantarlo.

Ramas: `feat/flota-inventario/schema-y-dominio` (backend) ·
`feat/flota-inventario/vistas` (frontend).

---

## 1. Para @Alexander — tu placeholder ya se reconcilió

Tu nota decía: *"cuando subas el modelo real de Flota hay que reconciliarlo:
borrar el mío y apuntar las relaciones al tuyo"*. Hecho. **No perdiste nada** y
**no tienes que tocar tu código de terreno** salvo dos detalles chicos:

- **El `Equipo` provisional se reemplazó por el real.** Tus 4 modelos
  (`RegistroCombustible`, `RegistroHorometro`, `TrabajoExtraordinario`,
  `Hallazgo`) siguen igual y sus relaciones ahora apuntan al `Equipo` de verdad.
  El `EquiposModule` provisional de solo-lectura lo reemplacé por el módulo CRUD
  real (`equipos.service.ts` + DTOs).
- **El estado del equipo cambió de vocabulario.** Antes era
  `OPERATIVO | DETENIDO | MANTENIMIENTO` (string). Ahora es un **enum Prisma**
  `EstadoEquipo = DISPONIBLE | EN_RUTA | EN_MANTENCION | DE_BAJA` — es el
  vocabulario del documento de requerimientos (§5.1) y el que ya asumía el
  dashboard de Benjamín (`estado === 'DISPONIBLE'`).
  - **Qué te toca:** tu UI de terreno **no renderiza `equipo.estado`** (lo
    confirmé), así que no se te rompe ninguna pantalla. Lo único con el valor
    viejo son tus **fixtures de test** (`estado: 'OPERATIVO'` / `'DETENIDO'` en
    los `.test.tsx` de terreno) — siguen compilando porque el tipo del front es
    `string`, pero conviene actualizarlos al vocabulario nuevo para que el mock
    refleje datos reales.
- **Tus columnas de terreno siguen como `String`** (turno, prioridad, tipo de
  combustible, etc.). No las toqué: migrarlas a enum Prisma es decisión tuya. Si
  quieres, te ayudo, pero no lo hice sin avisar.
- **Ojo con el borrado de equipos:** el `remove` de Flota **bloquea** eliminar un
  equipo que tenga registros de terreno asociados (devuelve 409 y sugiere pasarlo
  a `DE_BAJA`). Así tus hallazgos/horómetros nunca quedan huérfanos.

---

## 2. Para @Joaquín — el contrato de descuento de stock ya existe

Tu RFC (§5.1) pedía una función de Inventario para descontar stock de forma
atómica junto con la bitácora. Está lista y es exactamente la firma que
propusiste, con `tx` incluido:

```ts
// InventarioModule EXPORTA InventarioService. Importa el módulo e inyéctalo.
await this.prisma.$transaction(async (tx) => {
  const intervencion = await tx.intervencion.create({ data: { ... } });

  for (const item of dto.insumos) {
    await this.inventario.registrarSalida(
      {
        insumoId: item.insumoId,
        cantidad: item.cantidad,
        origen: OrigenMovimiento.INTERVENCION,
        responsableId: session.user.id,
        equipoId: orden.equipoId,     // opcional: imputa el consumo a la unidad
        referenciaId: intervencion.id, // trazabilidad bitácora ↔ movimiento
      },
      tx, // ← pasa el tx: bitácora + descuentos son todo-o-nada
    );
  }
  return intervencion;
});
```

Detalles del contrato:

- **`cantidad > stock` → `ConflictException` (409)** con mensaje "Stock
  insuficiente de X: disponible N, solicitado M". Al lanzarse dentro del `tx`,
  **revierte toda la transacción**: no queda la intervención a medias.
- El descuento es **atómico a nivel de fila** (`updateMany` con `stock >= cantidad`
  en el `WHERE`), así que dos consumos concurrentes no pueden dejar stock negativo.
- Cada llamada deja un `MovimientoInventario` con `saldoResultante` → tu bitácora
  "antes/después" sale directo del kardex, sin que calcules nada.
- Para tu join `IntervencionInsumo`: agrégalo a tu sección del schema cuando subas
  Mantenimiento. Yo dejé el `MovimientoInventario` como fuente de verdad del
  stock; tu join guarda la relación explícita bitácora↔insumo, como decías en el
  RFC. No hay choque.
- También hay `registrarEntrada` (compras/devoluciones) y `ajustarPorConteo`
  (conteo físico) — ver JSDoc en `src/modules/inventario/inventario.service.ts`.

---

## 3. Para @Benjamín — endpoints reales para el dashboard

`DASHBOARD-CONTRACTS.md` tenía a Flota/Inventario como "endpoint no existe aún".
Ya existen los dos de mi bloque:

| KPI del dashboard | Endpoint real | Nota |
|---|---|---|
| `equiposDisponibles.{disponibles,total}` | **`GET /api/equipos/resumen`** | Agregación server-side: `{ total, disponibles, porEstado }`. No hay que contar en cliente sobre el listado. |
| Stock bajo mínimo (si lo agregas) | **`GET /api/inventario/insumos/resumen`** | `{ total, bajoMinimo }`. |

El shape ya viene envuelto en `{ data, message }` como el resto. Cuando quieras,
en `DashboardAPI.ts` cambias el `mockResponse` de `equiposDisponibles` por
`axiosInstance.get('/api/equipos/resumen')` y listo — el schema Zod ya calza (lo
verifiqué contra el backend corriendo).

---

## 4. Endpoints que agregué (todos bajo `/api`, respuesta `{ data, message }`)

**Flota** (`src/modules/equipos/`):

| Método | Ruta | Roles | Qué hace |
|---|---|---|---|
| GET | `/api/equipos` | cualquiera con sesión | Lista + filtros `?estado&tipo&q` |
| GET | `/api/equipos/resumen` | cualquiera con sesión | Conteo por estado (dashboard) |
| GET | `/api/equipos/:id` | cualquiera con sesión | Ficha + `_count` por dominio + últimos consumos |
| POST | `/api/equipos` | ADMIN | Crear |
| PATCH | `/api/equipos/:id` | ADMIN | Editar ficha |
| PATCH | `/api/equipos/:id/estado` | ADMIN, **SUPERVISOR** | Cambio de estado (Control de Flota, §5.2) |
| DELETE | `/api/equipos/:id` | ADMIN | Baja física (bloqueada si hay historial) |

**Inventario** (`src/modules/inventario/`):

| Método | Ruta | Roles | Qué hace |
|---|---|---|---|
| GET | `/api/inventario/insumos` | cualquiera con sesión | Lista + `?q&bajoStock` |
| GET | `/api/inventario/insumos/resumen` | cualquiera con sesión | `{ total, bajoMinimo }` |
| GET | `/api/inventario/insumos/:id` | cualquiera con sesión | Ficha del insumo |
| GET | `/api/inventario/insumos/:id/kardex` | cualquiera con sesión | Insumo + historial de movimientos |
| POST | `/api/inventario/insumos` | ADMIN | Crear (stock inicial → movimiento COMPRA) |
| PATCH | `/api/inventario/insumos/:id` | ADMIN | Editar ficha (NO el stock) |
| POST | `/api/inventario/insumos/:id/ajuste` | ADMIN | Conteo físico |
| DELETE | `/api/inventario/insumos/:id` | ADMIN | Baja (bloqueada si tiene kardex) |
| GET | `/api/inventario/movimientos` | cualquiera con sesión | Kardex general + filtros por período |
| POST | `/api/inventario/movimientos` | ADMIN, MANTENEDOR | Movimiento manual |

**Regla de oro del módulo:** `Insumo.stock` NUNCA se escribe directo. Solo se
mueve vía `InventarioService`, que en la misma transacción deja el
`MovimientoInventario`. Por eso el kardex y el stock nunca se descuadran.

---

## 5. Frontend (rama `feat/flota-inventario/vistas`)

Calcado del patrón `users` (guía del front §Patrón CRUD): `types/` (Zod) →
`api/` (axios + `toDomainError`) → `hooks/` (query + mutations con toasts) →
`views/` (solo UI, HeroUI). Vistas nuevas:

- **`/equipos`** — lista con filtros, badges de estado, resumen por estado, CRUD
  (ADMIN) y cambio de estado rápido (ADMIN + SUPERVISOR).
- **`/equipos/:id`** — ficha técnica + contadores por dominio + últimos consumos.
- **`/inventario`** — insumos con alerta de stock bajo, alta, ajuste por conteo,
  y registro de movimientos.
- **`/inventario/:id`** — kardex del insumo (entradas/salidas con saldo).

Ajusté `routes.tsx` y `nav-items.ts` (archivos compartidos — aviso acá como pide
la guía §11): la lectura de Equipos/Inventario ahora la ven ADMIN + SUPERVISOR +
MANTENEDOR (terreno y taller necesitan consultar flota y stock); la escritura la
restringe el backend por endpoint.

---

## 6. Setup local — CAMBIÓ (importante)

El schema pasó de solo-auth a tener las tablas de dominio, así que hay una
**migración nueva** (`20260805154118_flota_inventario`) y el seed ahora crea
flota + inventario + terreno.

```bash
# backend
docker compose up -d          # Postgres en :5433  (ver nota abajo si no tienes Docker)
cp .env.example .env          # generar BETTER_AUTH_SECRET: openssl rand -base64 32
npm install
npx prisma migrate dev        # aplica las 3 migraciones
npm run db:seed               # 4 usuarios + 6 equipos + 10 insumos (4 bajo mínimo) + terreno
npm run start:dev
```

> **Nota (entorno sin Docker):** desarrollé y validé todo esto contra un Postgres
> 17 **portable** en `localhost:5433` con las credenciales del `.env.example`
> (`smi_user` / `smi_password` / `smi_db`) — mi máquina no tiene Docker. La
> migración, el seed y los endpoints corren idénticos contra el Postgres de
> `docker-compose.yml`; no cambié nada de la config de conexión.

**Estado de la migración vs. datos existentes:** la migración `DROP`ea y recrea la
columna `estado` de `Equipo` (cambia de string a enum). En una BD con datos
previos eso **borra los estados actuales** (Prisma avisa con warning). Como
estamos en demo con seed, no importa: se resiembra. Si alguien tiene datos que le
importan, avísenme antes de correr `migrate` y lo hacemos con un mapeo manual
(`OPERATIVO→DISPONIBLE`, `DETENIDO→DE_BAJA`, `MANTENIMIENTO→EN_MANTENCION`).

---

## 7. Validación (lo que corrí antes de subir)

- Backend: `prisma validate` ✓, `nest build` ✓, **26 tests** ✓ (services de
  equipos e inventario, incl. atomicidad del descuento y rechazo por stock).
  Verifiqué contra la BD real: login por rol, `resumen`, kardex, y el 409 por
  stock insuficiente **no descuenta** (transacción revertida).
- Frontend: `tsc -b` ✓, `vite build` ✓, `oxlint` ✓, **36 tests** ✓. Además validé
  que los schemas Zod del front parsean las respuestas **reales** del backend.
- **No toqué código de nadie más.** El `npm run lint` corre `eslint --fix` sobre
  todo el repo y reformateó archivos de terreno; lo revertí. Mi PR solo tiene mis
  archivos + los 3 compartidos que avisé (`schema.prisma`, `app.module.ts`,
  `routes.tsx`/`nav-items.ts` en el front).
- **Deuda que vi de paso (no la toqué, la reporto):** los `*.service.spec.ts` de
  terreno ya tienen 9 errores de `eslint` (`no-explicit-any`) en `main` — no son
  míos, pero conviene limpiarlos, @Alexander.
