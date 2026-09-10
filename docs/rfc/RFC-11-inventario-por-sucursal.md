# RFC-11 — Inventario de suministros y repuestos por sucursal

| Campo | Valor |
|---|---|
| **Ticket de Producto** | `PROD-11` — Consultar inventario de suministros y repuestos por sucursal |
| **Autor** | Joaquín |
| **Estado** | Borrador → En revisión |
| **Fecha** | 2026-09-08 |
| **Rama** | `feat/inventario/stock-por-sucursal` (backend) · `feat/inventario/stock-por-sucursal` (frontend) |
| **Dev** | `DEV-11` |
| **Toca zona compartida** | Sí — `prisma/schema.prisma`, `src/inventario/`, `app.module.ts`, `routes.tsx`, `nav-items.ts` |

---

## 1. Problema

Hoy `Insumo.stock` es **un solo número global**. La empresa arrienda maquinaria
minera y opera con bodegas en más de una sucursal/faena, así que ese número
responde una pregunta que nadie hace ("¿cuánto hay en la empresa?") y no responde
la que sí se hace todos los días:

> *"¿Tengo este filtro **en mi bodega**, o está a 300 km?"*

Consecuencias concretas del modelo actual:

- Un mantenedor ve `stock: 12` y pide el repuesto; las 12 unidades están en otra
  sucursal. El sistema lo dejó comprometerse con algo que no tiene a mano.
- La alerta de stock bajo (`stock <= stockMinimo`) es global: una sucursal puede
  estar en cero y la alerta nunca se enciende porque otra tiene de sobra.
- El kardex (`MovimientoInventario`) registra **qué** se movió y **quién**, pero
  no **dónde**. Un movimiento sin ubicación no es auditable en una operación
  multi-bodega.

## 2. Alcance

**Dentro:** modelo de sucursales, stock por sucursal, kardex con ubicación,
endpoints de consulta y la pantalla "Stock por sucursal".

**Fuera (explícitamente):**
- `PROD-13` *Mover stock entre sucursales con kardex trazable* — es de Benjamín.
  Este RFC deja la **base** sobre la que se implementa y documenta el seam en §7.
- `PROD-14` *Ver los ítems bajo el stock mínimo por sucursal* — también de
  Benjamín. Este RFC deja `StockSucursal.stockMinimo` listo, pero **no** construye
  su pantalla ni su endpoint de alertas.

No se toca ninguna vista ni endpoint existente de Flota, Terreno o Dashboard.

---

## 3. Opciones evaluadas

### Opción A — Duplicar la fila de `Insumo` por sucursal

`Insumo` gana `sucursalId` y la unicidad pasa a ser `(codigo, sucursalId)`.
"Filtro de aceite" existe una vez por bodega.

| | |
|---|---|
| ✅ | Cambio mínimo: `stock` sigue siendo una columna de `Insumo`; el service no se toca. |
| ❌ | **La ficha del repuesto se duplica N veces.** Corregir un nombre o una unidad = N updates. |
| ❌ | Se pierde `codigo` como identidad del repuesto. "Total en la empresa" pasa a ser un `GROUP BY` sobre un string, no una lectura por id. |
| ❌ | Mata a `RFC-12`: la compatibilidad repuesto↔equipo habría que declararla **una vez por copia** del repuesto. Absurdo. |

**Descartada.**

### Opción B — Tabla puente `StockSucursal`, con `Insumo.stock` como total consolidado ✅

`Insumo` sigue siendo la **ficha única** del repuesto (código, nombre, unidad,
compatibilidades). El saldo se muda a una tabla puente:

```
Sucursal (id, codigo, nombre, direccion?, activa, esPrincipal)
StockSucursal (insumoId, sucursalId, stock, stockMinimo)   @@unique([insumoId, sucursalId])
MovimientoInventario.sucursalId  → FK, NOT NULL
```

`Insumo.stock` **se conserva** y pasa a significar *"total en todas las
sucursales"*, escrito por el mismo service en la misma transacción que mueve
`StockSucursal.stock`.

| | |
|---|---|
| ✅ | Ficha única + saldo por bodega: cada dato en el lugar que le corresponde. |
| ✅ | El kardex gana ubicación; `saldoResultante` pasa a ser el saldo **de esa bodega**, que es el número auditable. |
| ✅ | **Cero rupturas.** Dashboard, ficha consolidada, `GET /inventario/insumos`, `/resumen`, el filtro `bajoStock` y todo el frontend actual siguen leyendo `Insumo.stock` y siguen siendo correctos: ahora es el total. |
| ✅ | Habilita `PROD-13` (traslado = SALIDA en origen + ENTRADA en destino, mismo `referenciaId`) y `PROD-14` (`StockSucursal.stockMinimo`) sin rediseñar nada. |
| ⚠️ | `Insumo.stock` queda **denormalizado** y en teoría puede derivar. Mitigación en §5. |

**Elegida.**

### Opción C — Eliminar `Insumo.stock`; el total siempre se calcula con `SUM`

| | |
|---|---|
| ✅ | Una sola fuente de verdad. Imposible que derive. |
| ❌ | Obliga a reescribir **todo** lo que hoy lee `insumo.stock`: el listado, `/resumen`, `estaBajoMinimo()` del front, los KPIs del dashboard y sus tests. |
| ❌ | El filtro "bajo stock" hoy es `stock <= stockMinimo` resuelto **en SQL** con la referencia de campo de Prisma. Sobre un agregado eso no se puede expresar sin `queryRaw`. |
| ❌ | Es meterse a reescribir el dominio del compañero **justo cuando tiene `PROD-13` y `PROD-14` en vuelo** sobre esos mismos archivos. Conflicto garantizado. |

**Descartada por costo y riesgo de colisión, no por elegancia.** Si más adelante
la denormalización molesta, migrar de B a C es un cambio local al service.

---

## 4. Decisión

**Opción B.** El criterio que decide es el de menor superficie de ruptura: la
Opción B es *aditiva* — agrega tablas y columnas, no cambia el significado de
ninguna lectura existente — mientras que la C es *sustractiva* y arrastra a tres
dominios que hoy no tienen nada que ver con sucursales.

---

## 5. Diseño

### 5.1 Schema

```prisma
model Sucursal {
  id          String  @id @default(cuid())
  codigo      String  @unique          // CENTRAL, NORTE, ...
  nombre      String
  direccion   String?
  activa      Boolean @default(true)
  /// Bodega por defecto. Exactamente una en true — lo garantiza el service,
  /// no un constraint: Postgres no expresa "único entre los true" sin índice parcial.
  esPrincipal Boolean @default(false)

  stocks      StockSucursal[]
  movimientos MovimientoInventario[]
}

model StockSucursal {
  id          String @id @default(cuid())
  insumoId    String
  sucursalId  String
  stock       Float  @default(0)
  /// Mínimo POR BODEGA. Independiente de Insumo.stockMinimo (que es el global).
  stockMinimo Float  @default(0)

  @@unique([insumoId, sucursalId])
  @@index([sucursalId])
}
```

`Insumo` gana además:

```prisma
enum TipoInsumo { SUMINISTRO REPUESTO }
tipo TipoInsumo @default(SUMINISTRO)
```

El ticket habla de *"suministros **y** repuestos"* y hoy el modelo no los
distingue. Es una columna barata que permite filtrar la bodega por tipo y le da
sentido a la pestaña de compatibilidades de `RFC-12`. **No** restringe nada: un
suministro también puede declararse compatible con un equipo.

### 5.2 Invariante y cómo se sostiene

> **Invariante:** `Insumo.stock == Σ StockSucursal.stock` para todo insumo.

Se sostiene con tres cosas, no con buena fe:

1. **Un solo camino de escritura.** La regla de oro del módulo ya vigente —
   `Insumo.stock` nunca se escribe fuera de `InventarioService` — se extiende a
   `StockSucursal.stock`. Ambos updates ocurren en la **misma transacción** que
   crea el `MovimientoInventario`.
2. **El descuento sigue siendo atómico a nivel de fila.** El `updateMany` con
   `stock >= cantidad` en el `WHERE` se mueve a `StockSucursal`: dos salidas
   concurrentes sobre la misma bodega no pueden dejar saldo negativo. Sin eso,
   partir el saldo en N filas habría multiplicado por N la ventana de carrera.
3. **Un test que verifica la invariante** después de una secuencia de
   entradas/salidas/ajustes en varias sucursales.

### 5.3 Contrato con los otros dominios — se mantiene compatible

`RegistrarMovimientoInput` gana `sucursalId?` **opcional**. Si no viene, se usa
la sucursal principal.

Esto es deliberado: el contrato que Amin documentó para Mantenimiento y Terreno
(`registrarSalida({ insumoId, cantidad, origen, responsableId, equipoId,
referenciaId }, tx)`) **sigue compilando y comportándose igual**. Hacerlo
obligatorio habría obligado a Alexander y a mí a modificar call-sites de dominios
que todavía no razonan sobre bodegas, a cambio de nada. Cuando cada dominio tenga
sucursal (la OT sabrá en qué faena se ejecuta), pasa a mandarla explícita.

### 5.4 Endpoints nuevos (todos aditivos, `{ data, message }`)

| Método | Ruta | Roles | Qué hace |
|---|---|---|---|
| GET | `/api/sucursales` | sesión | Lista (`?activa`) |
| GET | `/api/sucursales/:id` | sesión | Ficha |
| POST | `/api/sucursales` | ADMIN | Crear |
| PATCH | `/api/sucursales/:id` | ADMIN | Editar / marcar principal |
| DELETE | `/api/sucursales/:id` | ADMIN | Baja (bloqueada si tiene stock o kardex) |
| GET | `/api/inventario/stock` | sesión | **La consulta del ticket**: `?sucursalId&q&tipo&bajoStock` → insumos con su saldo en esa bodega + total empresa |
| GET | `/api/inventario/insumos/:id/stock` | sesión | Desglose del insumo bodega por bodega |

`GET /api/inventario/movimientos` gana `?sucursalId` y `POST` acepta `sucursalId`.
Los endpoints existentes **no cambian de forma**.

### 5.5 Migración de datos

La migración no puede dejar huérfano el kardex histórico:

1. Crear `Sucursal` `CENTRAL` — "Casa Matriz", `esPrincipal = true`.
2. Por cada `Insumo`, crear su `StockSucursal` en CENTRAL con el `stock` y
   `stockMinimo` actuales → la invariante se cumple desde el minuto cero.
3. `MovimientoInventario.sucursalId` se agrega **nullable**, se backfillea a
   CENTRAL y recién ahí se marca `NOT NULL`.

Ninguna fila se pierde y ninguna lectura existente cambia de resultado.

---

## 6. Frontend

Vista **nueva** `views/StockSucursalView.tsx` en `/inventario/stock`, no una
modificación de `InventarioView`. Razón: `PROD-13` y `PROD-14` de Benjamín van a
tocar `InventarioView`; meter mi selector de sucursal ahí garantiza conflicto en
el mismo archivo. Una vista propia es además lo que pide el ticket ("consultar
inventario **por sucursal**" es una pantalla, no un filtro escondido).

Selector de sucursal · buscador · filtro suministro/repuesto · filtro bajo mínimo
· tabla con **stock en la bodega** y **total empresa** lado a lado · expandir un
insumo muestra su desglose por sucursal.

Compartidos que toco (aviso según guía §11): `routes.tsx`, `nav-items.ts`.

---

## 7. Seams que quedan listos para Benjamín

- **`PROD-13` (traslado):** `InventarioService.trasladar(origen, destino,
  insumoId, cantidad)` = `aplicarSalida` en origen + `aplicarEntrada` en destino
  dentro de **un solo `$transaction`**, ambos movimientos con el mismo
  `referenciaId` para que el kardex los muestre apareados. Falta solo agregar
  `TRASLADO` a `OrigenMovimiento` y el endpoint. La atomicidad ya está resuelta.
- **`PROD-14` (bajo mínimo por sucursal):** `StockSucursal.stockMinimo` ya existe
  y `GET /api/inventario/stock?bajoStock=true&sucursalId=` ya devuelve exactamente
  esa lista. Su ticket es la pantalla de alertas y el resumen agregado.

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| `Insumo.stock` deriva de la suma | Escritura única en el service + test de invariante (§5.2) |
| Choque en `schema.prisma` con `PROD-13/14` | Mis modelos son nuevos; el único cambio a tabla existente es agregar columnas. Aviso al equipo antes del PR |
| Un insumo sin fila en una sucursal | Se trata como stock 0; la fila se crea (upsert) al primer movimiento en esa bodega |
