# Inventario por sucursal + compatibilidad repuesto ↔ equipo

**Fecha:** 2026-09-08 · **Autor:** Joaquín · **Tickets:** `PROD-11` / `RFC-11` / `DEV-11` y `PROD-12` / `RFC-12` / `DEV-12`

Nota de handoff. Dos funcionalidades que comparten base: el inventario pasó a ser
multi-bodega, y sobre eso se apoya la consulta de repuestos compatibles.

RFCs completos en `docs/rfc/RFC-11-inventario-por-sucursal.md` y
`docs/rfc/RFC-12-compatibilidad-repuesto-equipo.md`.

Ramas: `feat/inventario/stock-por-sucursal` (backend y frontend).

---

## 1. Para @Benjamín — esto es la base de tus PROD-13 y PROD-14

**Nada de lo tuyo se rompe.** `Insumo.stock` sigue existiendo y sigue siendo
correcto: ahora significa *"total sumado sobre todas las sucursales"*. El
dashboard, la ficha consolidada, `GET /inventario/insumos`, `/resumen` y el
filtro `bajoStock` devuelven exactamente lo mismo que antes.

Lo que agregué te deja los dos tickets casi armados:

- **`PROD-13` (mover stock entre sucursales con kardex trazable):**
  `InventarioService` ya resuelve lo difícil. Un traslado es
  `aplicarSalida(origen)` + `aplicarEntrada(destino)` dentro de **un solo
  `$transaction`**, los dos movimientos con el mismo `referenciaId` para que el
  kardex los muestre apareados. Te falta: agregar `TRASLADO` a
  `OrigenMovimiento`, un método `trasladar()` y el endpoint. La atomicidad y el
  "nunca dejar saldo negativo" ya están resueltos y testeados.
- **`PROD-14` (ítems bajo el mínimo por sucursal):**
  `StockSucursal.stockMinimo` ya existe, se puede configurar
  (`PUT /api/inventario/stock/minimo`) y
  `GET /api/inventario/stock?bajoStock=true&sucursalId=` **ya devuelve esa lista
  exacta**. Deliberadamente **no** construí el resumen agregado ni la pantalla de
  alertas: eso es tu ticket. Los contadores de mi vista se calculan sobre las
  filas que ya traigo, justo para no adelantarte medio ticket.

**Ojo con esto, que te toca de lleno:** la regla de alerta por bodega vive en
`src/inventario/stock/minimo-efectivo.ts` (`evaluarMinimoBodega`) y dice:

> `Insumo.stockMinimo` (empresa) y `StockSucursal.stockMinimo` (bodega) **no son
> la misma magnitud**. El global NO se hereda como umbral de bodega. Una bodega
> sin mínimo propio (`0`) no emite alerta de bodega.

La primera versión sí heredaba el global, con el argumento de que "el peor error
es no avisar". Al levantar el entorno con datos reales quedó claro que era al
revés: los mínimos globales están calibrados sobre el total de la empresa, así
que compararlos contra la porción de una bodega marcaba **10 de 10 ítems** como
bajo mínimo. Una alerta que se enciende siempre no es una alerta — enseña a
ignorar la pantalla, que es la peor falla posible para PROD-14.

Está en su propio archivo porque lo usan dos dominios (stock y repuestos
compatibles); si tu pantalla de alertas usa otra regla, las dos vistas van a
discrepar sobre la misma fila. El seed ya siembra umbrales por bodega, así que
tenés casos reales con los que trabajar (4 alertas en Casa Matriz, 1 en Faena).

## 2. Para @Alexander — no tienes que tocar nada

El contrato de descuento de stock (`registrarSalida`/`registrarEntrada`)
**sigue siendo el mismo**. `sucursalId` se agregó como campo **opcional**: si no
lo mandas, el movimiento va a la sucursal principal. Tu código compila y se
comporta igual.

Cuando tus registros de terreno sepan en qué faena ocurrieron, pasas
`sucursalId` y el service no cambia.

---

## 3. Qué cambió en el schema

| Cambio | Tipo |
|---|---|
| `Sucursal` (codigo, nombre, direccion, activa, esPrincipal) | tabla nueva |
| `StockSucursal` (insumo × sucursal → stock, stockMinimo) | tabla nueva |
| `CompatibilidadEquipoInsumo` (equipo × insumo → nota) | tabla nueva |
| `Insumo.tipo` → `SUMINISTRO \| REPUESTO` | columna nueva, default `SUMINISTRO` |
| `MovimientoInventario.sucursalId` | columna nueva, `NOT NULL` tras backfill |

**Ningún campo existente cambió de tipo ni de significado**, salvo que
`Insumo.stock` pasó a ser el consolidado (numéricamente idéntico a antes con una
sola bodega) y `MovimientoInventario.saldoResultante` ahora es el saldo **de esa
bodega**, no el de la empresa.

### Invariante que hay que respetar

> `Insumo.stock == Σ StockSucursal.stock`

Se sostiene porque **el único camino de escritura sigue siendo
`InventarioService`**, que mueve los dos en la misma transacción junto con el
`MovimientoInventario`. La regla de oro del módulo no cambió, solo se extendió:
nadie escribe `stock` ni `StockSucursal.stock` fuera de ese service. Hay un test
que lo verifica y el seed lo comprueba sobre datos reales antes de terminar.

---

## 4. Endpoints nuevos (todos `{ data, message }`)

**Sucursales** (`src/sucursales/`)

| Método | Ruta | Roles |
|---|---|---|
| GET | `/api/sucursales` (`?activa`) | sesión |
| GET | `/api/sucursales/:id` | sesión |
| POST | `/api/sucursales` | ADMIN |
| PATCH | `/api/sucursales/:id` | ADMIN |
| DELETE | `/api/sucursales/:id` | ADMIN (bloqueado si tiene kardex, saldo o es principal) |

**Stock por bodega** (`src/inventario/stock/`)

| Método | Ruta | Roles |
|---|---|---|
| GET | `/api/inventario/stock` (`?sucursalId&q&tipo&bajoStock&soloEnBodega`) | sesión |
| GET | `/api/inventario/insumos/:id/stock` (desglose por bodega) | sesión |
| PUT | `/api/inventario/stock/minimo` | ADMIN |

**Compatibilidad** (`src/compatibilidad/`)

| Método | Ruta | Roles |
|---|---|---|
| GET | `/api/equipos/:equipoId/repuestos` (`?sucursalId&soloConStock`) | sesión |
| GET | `/api/equipos/:equipoId/repuestos/replicables` | sesión |
| POST | `/api/equipos/:equipoId/repuestos/replicar` | ADMIN, MANTENEDOR |
| GET | `/api/inventario/insumos/:id/equipos` | sesión |
| POST · PATCH · DELETE | `/api/compatibilidades[/:id]` | ADMIN, MANTENEDOR |

Endpoints existentes que ganaron campos **opcionales** (ninguno rompe clientes):
`POST /api/inventario/movimientos` y `POST /api/inventario/insumos` aceptan
`sucursalId`; `POST /api/inventario/insumos/:id/ajuste` acepta `sucursalId`;
`GET /api/inventario/movimientos` y `GET /api/inventario/insumos` aceptan
`?sucursalId` y `?tipo`.

> **MANTENEDOR escribe compatibilidades**, no solo ADMIN. Quien descubre que un
> repuesto calza es el mecánico con la máquina abierta al frente; obligarlo a
> pedirle a un admin que lo registre es la vía más rápida a que el dato nunca se
> registre — el problema que la funcionalidad viene a resolver.

---

## 5. Frontend

Dos vistas **nuevas**, para no chocar con `PROD-13`/`PROD-14` en
`InventarioView.tsx`:

- **`/inventario/stock`** — "Stock por sucursal": selector de bodega, filtros
  (texto, suministro/repuesto, bajo mínimo, solo lo que maneja la bodega), y por
  cada ítem el saldo **acá** junto al **total empresa**. El modal "¿Dónde hay?"
  muestra el desglose bodega por bodega.
- **`/equipos/:id/repuestos`** — repuestos compatibles de una máquina, cruzados
  con el stock de la bodega elegida, con alta/baja y el aviso de replicación.

Los tres estados de disponibilidad (`En esta bodega` / `En otra sucursal` /
`Sin stock`) **no se colapsan en "hay / no hay"** a propósito: llevan a acciones
distintas — usar, pedir un traslado, o comprar. Y "quedan pocos" tampoco se
muestra como "no hay": la alerta de reposición va en un chip aparte.

### Archivos compartidos que toqué (aviso según guía §11)

- `routes.tsx` y `config/nav-items.ts` — las dos rutas nuevas y el ítem de menú.
- `views/EquipoDetalleView.tsx` — **una línea**: el enlace "Repuestos
  compatibles →".
- `views/InventarioView.tsx` — **acá sí hay cambio de fondo, y es intencional**:
  los formularios que MUEVEN saldo (movimiento manual, conteo físico, stock
  inicial al crear un insumo) ahora exigen bodega. Dejarlos sin ella habría hecho
  que un bodeguero en Faena Norte registrara su compra en Casa Matriz sin
  enterarse, y el descuadre solo aparecería en el siguiente conteo físico. El
  conteo físico además compara contra el saldo **de esa bodega**: contra el total
  habría registrado como faltante todo lo guardado en otras sucursales.
- `types/inventario.ts` — `tipo` en el insumo y `sucursalId` en el movimiento.
  `TIPOS_INSUMO` se define acá (no en `types/stock.ts`) porque importarse
  mutuamente dejaba una de las dos constantes en `undefined` al inicializar el
  módulo y `z.enum` reventaba.

---

## 6. Validación (lo que corrí)

- **Backend:** `prisma validate` ✓ · `prisma generate` ✓ · `nest build` ✓ ·
  `eslint` ✓ · **81 tests** ✓ (16 suites), incluidos los nuevos de
  `SucursalesService`, `StockService` y `CompatibilidadService`, y el
  `inventario.service.spec.ts` reescrito para el modelo multi-bodega.
- **Frontend:** `tsc -b` ✓ · `vite build` ✓ · `oxlint` ✓ · **76 tests** ✓
  (19 suites).

### Verificado contra la base y la API reales

Las dos migraciones **se aplicaron** sobre el Postgres local
(`docker compose up -d postgres`, contenedor `smi-postgres` en `:5433`);
`prisma migrate status` reporta *Database schema is up to date*. El seed corre y
los endpoints se probaron con una sesión real (`admin@smi.local`):

```bash
docker compose up -d postgres
npx prisma migrate deploy
npm run db:seed             # 2 sucursales, 7 equipos, 10 insumos, 14 compatibilidades
npm run start:dev
```

- `GET /api/sucursales` → CENTRAL (principal) y FAENA.
- `GET /api/inventario/stock` → saldo por bodega + total empresa; 4 de 10 bajo el
  mínimo en Casa Matriz, 1 de 10 en Faena.
- `GET /api/inventario/insumos/:id/stock` → desglose por bodega (NEU-001: 0 en
  Casa Matriz, 2 en Faena).
- `GET /api/equipos/:id/repuestos` → compatibles cruzados con el stock de la
  bodega; `/repuestos/replicables` sugiere EX-001 para EX-007.
- La invariante `Insumo.stock == Σ StockSucursal.stock` da **0 descuadres** en SQL.

### ⚠️ Lo que queda por verificar

- **El backfill sobre una base con datos previos.** Las migraciones se aplicaron
  y el seed resiembra, pero no se ejercitó el caso "BD poblada de antes":
  `20260908120000_inventario_por_sucursal` crea `CENTRAL`, le asigna el stock
  actual de cada insumo y apunta todo el kardex existente a ella **antes** de
  poner `sucursalId` en `NOT NULL`. Ese orden es lo delicado si alguien migra
  una base que no piensa resembrar.
- **Rotura preexistente de `main` (no es de este PR):** el seed muere al final,
  en `seedMantenimiento`, porque `public.orden_trabajo` no existe — su migración
  vive en `feat/mantenimiento/api`, sin mergear. Usuarios, flota, inventario y
  terreno cargan completos antes de eso.

---

## 7. Deuda y decisiones que dejo anotadas

- **`Insumo.stock` es un dato denormalizado.** Es la contrapartida consciente de
  no romper a nadie (RFC-11 §3, Opción C descartada). Si algún día molesta,
  migrar a "total calculado con `SUM`" es un cambio local a `InventarioService` +
  las lecturas del listado.
- **Un equipo nuevo no hereda las compatibilidades de sus gemelos.** Es el precio
  de anclar la relación a ids en vez de a `marca`/`modelo` en texto libre
  (RFC-12 §4). Se compensa con el botón "copiar de `<código>`", que aparece solo
  cuando hace falta.
- **El match por marca+modelo se usa únicamente como sugerencia** (para ofrecer
  el atajo de replicación). Nunca como fuente de verdad de la compatibilidad: un
  typo en el alta del equipo deja sin atajo, no sin repuestos.
- **Eliminé un import muerto** (`TipoMovimiento`) en `prisma/seed.ts`. Ya estaba
  sin usar en `main` y `eslint` lo marcaba; lo saqué porque estaba editando esa
  misma línea de import, no por reformatear el archivo.
- **Agregué `EX-007` al seed** (gemelo de `EX-001`, sin compatibilidades) para
  que el flujo de replicación se pueda demostrar. La flota de la demo pasa de 6
  a 7 equipos; los índices que usan los consumos del seed no cambian.
