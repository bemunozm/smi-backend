# RFC-12 — Compatibilidad repuesto ↔ equipo

| Campo | Valor |
|---|---|
| **Ticket de Producto** | `PROD-12` — Saber qué repuestos son compatibles con cada equipo |
| **Autor** | Joaquín |
| **Estado** | Borrador → En revisión |
| **Fecha** | 2026-09-08 |
| **Rama** | `feat/inventario/compatibilidad-repuestos` |
| **Dev** | `DEV-12` |
| **Depende de** | `RFC-11` (para cruzar compatibilidad con stock por sucursal) |

---

## 1. Problema

El mantenedor abre una orden de trabajo sobre una excavadora y necesita saber
**qué repuestos le sirven** antes de ir a bodega. Hoy el sistema no lo sabe: el
conocimiento vive en la cabeza del mecánico con más años. Bodega tiene el problema
espejo — le llega un repuesto y no sabe en qué máquinas se usa, así que no puede
decidir si conviene reponerlo.

El costo real: se pide el repuesto equivocado, la máquina queda detenida un día
más, y en una operación de arriendo eso se factura.

## 2. Alcance

**Dentro:** modelo de compatibilidad, endpoints en ambas direcciones
(equipo→repuestos y repuesto→equipos), acción de replicación por marca+modelo, y
la pantalla de repuestos compatibles de un equipo cruzada con stock.

**Fuera:** sugerencia automática de repuestos por historial de consumo, y enganche
con la orden de trabajo (pedir el repuesto desde la OT). Son tickets futuros.

---

## 3. Opciones evaluadas

### Opción A — Campo de texto libre en `Insumo`

`Insumo.compatibleCon: String?` → `"CAT 320D, Komatsu PC200"`.

| | |
|---|---|
| ✅ | Cero modelo, media hora de trabajo. |
| ❌ | **No es consultable.** No se puede responder "¿qué repuestos sirven para este equipo?" sin un `LIKE` sobre texto libre. |
| ❌ | Imposible cruzarlo con stock, que es donde está el valor real de la funcionalidad. |
| ❌ | Es una nota, no un dato. Repite el problema que ya tenemos (el conocimiento suelto), solo que ahora en una columna. |

**Descartada.**

### Opción B — Regla por marca + modelo

`CompatibilidadModelo (insumoId, marca, modelo)`, y al consultar un equipo se
matchea contra `Equipo.marca` / `Equipo.modelo`.

| | |
|---|---|
| ✅ | **Modela la realidad correcta**: un filtro es compatible con un *modelo* de máquina, no con una máquina puntual. |
| ✅ | Se declara una vez y cubre automáticamente las máquinas futuras de ese modelo. |
| ❌ | `Equipo.marca` y `Equipo.modelo` son **texto libre sin catálogo**. "CAT" vs "Caterpillar", "320D" vs "320 D", un espacio de más → el equipo se queda sin repuestos y nadie se entera. |
| ❌ | Sin integridad referencial: nada impide una regla para un modelo que no existe. |
| ❌ | Arreglarlo bien exige un catálogo `ModeloEquipo` y migrar `Equipo` a FK → **tocar el modelo central de Flota**, dominio compartido, con alto costo y riesgo de conflicto. |

**Descartada por la calidad del dato disponible**, no por el concepto: el concepto
es el correcto y se recupera en la Opción C con la acción de replicación.

### Opción C — N:M explícita `Equipo ↔ Insumo` + replicación por marca/modelo ✅

```prisma
model CompatibilidadEquipoInsumo {
  id        String @id @default(cuid())
  equipoId  String   // FK real → Equipo
  insumoId  String   // FK real → Insumo
  nota      String?  // "solo desde nº serie 4500", "usar con adaptador"
  @@unique([equipoId, insumoId])
}
```

Más una acción: **replicar** las compatibilidades de un equipo a todos los equipos
con la misma `marca` + `modelo`.

| | |
|---|---|
| ✅ | **FK reales en ambos lados**: integridad garantizada, borrado en cascada limpio, imposible apuntar a un equipo o insumo inexistente. |
| ✅ | Habilita la consulta que da el valor: *"repuestos compatibles con este equipo **y su stock en mi sucursal**"* resuelta en **un join indexado**. Con la Opción B eso sería un match de strings imposible de cruzar con `StockSucursal`. |
| ✅ | La replicación recupera la ergonomía del modelo (declaras una vez, se aplica a las 6 excavadoras iguales) **sin inventar un catálogo ni tocar `Equipo`**. |
| ✅ | Permite excepciones reales: la misma máquina modificada en terreno que ya no usa el repuesto estándar. Con reglas por modelo, la excepción no se puede expresar. |
| ⚠️ | Un equipo nuevo del mismo modelo **no hereda** las compatibilidades. Mitigación abajo. |

**Elegida.**

---

## 4. Decisión

**Opción C.** El argumento decisivo no es el modelado en abstracto — ahí gana B —
sino **la calidad del dato que efectivamente tenemos**: `marca`/`modelo` son texto
libre escrito a mano. Una funcionalidad de seguridad operacional (¿qué repuesto le
pongo a esta máquina?) no puede depender de que dos personas hayan tecleado
"Caterpillar" igual. La Opción C ancla la relación a ids y recupera la comodidad
del modelo con una acción explícita.

**Mitigación del punto débil:** cuando se abre la pestaña de repuestos de un equipo
que **no tiene** compatibilidades declaradas y existe otro equipo con la misma
marca+modelo que sí las tiene, la UI ofrece *"Copiar las N compatibilidades de
`<código>` (mismo marca/modelo)"*. El hueco se cierra en un clic, en el momento
exacto en que se nota.

---

## 5. Diseño

### 5.1 Endpoints (`{ data, message }`)

| Método | Ruta | Roles | Qué hace |
|---|---|---|---|
| GET | `/api/equipos/:equipoId/repuestos` | sesión | **La consulta del ticket.** Repuestos compatibles + stock. Con `?sucursalId` agrega el saldo en esa bodega |
| GET | `/api/inventario/insumos/:insumoId/equipos` | sesión | Dirección inversa: en qué equipos se usa este repuesto |
| POST | `/api/compatibilidades` | ADMIN, MANTENEDOR | Declarar `{ equipoId, insumoId, nota? }` |
| PATCH | `/api/compatibilidades/:id` | ADMIN, MANTENEDOR | Editar la nota |
| DELETE | `/api/compatibilidades/:id` | ADMIN, MANTENEDOR | Quitar |
| GET | `/api/equipos/:equipoId/repuestos/replicables` | sesión | Equipos del mismo marca+modelo con compatibilidades para copiar |
| POST | `/api/equipos/:equipoId/repuestos/replicar` | ADMIN, MANTENEDOR | Copia desde `{ origenId }`, ignora las ya existentes |

**MANTENEDOR puede escribir** (no solo ADMIN): quien descubre que un repuesto
calza es el mecánico con la máquina abierta al frente. Obligarlo a pedirle a un
admin que lo registre es la vía más rápida a que el dato nunca se registre.

### 5.2 Dónde vive el código

Módulo propio `src/compatibilidad/` con dos controllers: `/api/compatibilidades`
y `/api/equipos/:equipoId/repuestos`. **No se edita `equipos.controller.ts`** —
el segundo controller declara su propia ruta y Express la resuelve sin ambigüedad
(`/equipos/:id` y `/equipos/:id/repuestos` tienen distinta cantidad de segmentos).
Así la funcionalidad cuelga del equipo en la API sin tocar el archivo de Flota.

### 5.3 El cruce con stock

La respuesta de `GET /api/equipos/:equipoId/repuestos?sucursalId=X` trae, por
repuesto: `codigo`, `nombre`, `unidad`, `nota`, `stockTotal` y `stockSucursal`.
Es exactamente la información con la que el mantenedor decide: *sirve, y lo tengo
acá*. Esta es la razón concreta por la que `RFC-12` depende de `RFC-11` y no al
revés.

### 5.4 Frontend

Vista nueva `views/RepuestosEquipoView.tsx` en `/equipos/:id/repuestos`:
lista de compatibles con chip de stock (verde con saldo en la bodega, ámbar solo
con saldo en otra, rojo sin stock), alta por buscador de insumos, nota editable,
y el banner de replicación cuando corresponde.

Compartidos que toco: `routes.tsx`, `nav-items.ts`, y **una línea** en
`EquipoDetalleView.tsx` (un botón "Repuestos compatibles"). Se avisa en el PR.

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| Equipo nuevo sin compatibilidades heredadas | Banner de replicación en un clic (§4) |
| Se declara compatibilidad contra un consumible a granel | No se bloquea: `TipoInsumo` (RFC-11) filtra el buscador a REPUESTO por defecto, pero permite ver todo |
| Borrar un equipo o un insumo | `onDelete: Cascade` en ambas FK: la compatibilidad no sobrevive a sus extremos, y no bloquea la baja |
