# RFC-4 — Faenas (Patillo / Kainita): ¿son `Branch` o son un eje aparte?

| Campo | Valor |
|---|---|
| **Ticket de Producto** | `PROD-17` — Registrar en qué faena ocurre cada cosa (Patillo / Kainita) |
| **Autor** | Joaquín |
| **Estado** | Borrador → En revisión |
| **Fecha** | 2026-09-20 |
| **Rama sugerida** | `feat/terreno/faenas-patillo-kainita` (backend) · `feat/terreno/selector-de-faena` (frontend) |
| **Dev** | `DEV-45` (T20) · `DEV-46` (T21) |
| **Depende de** | `RFC-3` — este RFC modifica `Branch`, que RFC-3 definió |
| **Toca zona compartida** | Sí — `prisma/schema.prisma` (dominio **Flota**, de Benjamín, y dominio **Terreno**, de Alexander), `prisma/seed.ts`, `src/branch/`, `src/terreno/` |

---

## 1. Problema

Sima opera **dos faenas: Patillo y Kainita**. El sistema no lo sabe.

De las cuatro vistas de Terreno, **solo una pregunta dónde pasó la cosa**, y lo
hace mal:

| Modelo | ¿Registra el lugar? |
|---|---|
| `Hallazgo` | ❌ no |
| `RegistroCombustible` | ❌ no |
| `RegistroHorometro` | ❌ no |
| `TrabajoExtraordinario` | ⚠️ `faena String` — texto libre, placeholder *«Ej: Rajo Norte»* |

Un hallazgo crítico, una carga de 400 litros y un turno de 12 horas se guardan
hoy **sin lugar**. El supervisor de Patillo ve los registros de Kainita
mezclados con los suyos y no tiene forma de separarlos. Y el único campo que sí
existe es un `String` que cada operador escribe como quiere: *"Rajo Norte"*,
*"rajo norte"*, *"RN"* son tres faenas distintas para la base de datos.

Pero el problema de fondo no es agregar una columna. Es que **el sistema ya
tiene una dimensión de lugar** — `Branch`, de RFC-3 — sembrada como «Casa
Matriz» y «Faena». Si Terreno inventa la suya, quedan dos claves para el mismo
sitio físico y la pregunta que importa deja de poder responderse:

> *"Patillo consumió 3 filtros de aire este mes. ¿Le quedan en bodega?"*

Con una clave, es una lectura. Con dos, es un join contra un mapeo que nadie
mantiene.

**Esto hay que resolverlo antes de escribir la migración, no después:** T20 es
la primera tarjeta de la tanda de Terreno y las otras 23 cuelgan de ella.

## 2. Alcance

**Dentro:**

- Decidir si la faena es una `Branch` o un modelo propio.
- Cómo registran el lugar los cuatro modelos de Terreno.
- Qué pasa con `TrabajoExtraordinario.faena: String`.
- Corregir el seed con las faenas reales.

**Fuera (explícitamente):**

- **El grano sub-faena.** «Hallazgo de un lugar» (T32) dejó abierto qué
  identifica *el lugar* dentro de la faena: texto libre vs. lista de sectores.
  Este RFC decide el nivel **faena** y deja el nivel **sector** abierto a
  propósito — ver §8.2. Lo que se decida ahí cuelga de la faena, no la
  reemplaza.
- **Renombrar el dominio Terreno a inglés.** Los modelos de Terreno están en
  español (`Hallazgo`, `RegistroCombustible`…) y son de Alexander. Este RFC no
  los renombra; ver D3.
- La pantalla del supervisor (T38) y el resto de la tanda.

---

## 3. Opciones evaluadas

### Opción A — La faena **es** una `Branch`, con un discriminador ✅

`Branch` gana `kind: BranchKind { OFFICE | SITE }`. El seed pasa a ser Casa
Matriz (`OFFICE`), Patillo (`SITE`), Kainita (`SITE`). Los cuatro modelos de
Terreno ganan una FK `branchId` a `Branch`, y el servicio exige que la sucursal
apuntada sea `SITE` y esté activa.

| | |
|---|---|
| ✅ | **Una sola clave.** «Stock en Patillo» y «hallazgo en Patillo» son la misma fila. El cruce consumo↔existencias es una lectura, no un mapeo. |
| ✅ | Reutiliza lo que ya existe: `GET /api/branches`, `Equipment.homeBranchId`, y el `selectedBranchId` que ya vive en el store de UI (`src/store/ui.ts`, T12). El selector de Terreno (T21) es ese mismo selector filtrado. |
| ✅ | Agregar una tercera faena es **una fila**, no una migración. |
| ❌ | Toca `Branch`, que es de Benjamín → hay que coordinarlo (§7). |
| ❌ | «Sucursal» pasa a significar dos cosas distinguidas por una columna. La regla *"Terreno solo apunta a `SITE`"* la sostiene el servicio, no la FK (D1). |

### Opción B — `Site` como modelo propio, eje aparte

`model Site { id, name, isActive }` nuevo, con FK desde los cuatro modelos de
Terreno. Opcionalmente `Branch.siteId` para decir qué bodega sirve a qué faena.

| | |
|---|---|
| ✅ | Semántica limpia: una faena no es una bodega, y el modelo no miente. |
| ✅ | Soporta lo que A no soporta: una faena abastecida por **varias** bodegas, o una faena **sin** bodega. |
| ✅ | La regla del discriminador desaparece — un registro de Terreno no puede apuntar a una oficina porque `Site` no las contiene. |
| ❌ | **Dos claves para el mismo lugar físico.** Toda pregunta que cruce inventario con terreno pasa por un mapeo `Branch ↔ Site` que hay que poblar y mantener a mano, y que se desincroniza en silencio. |
| ❌ | Módulo nuevo, endpoint nuevo, seed nuevo y **un segundo selector** en la UI (o una regla que traduzca el de sucursal al de faena). |
| ❌ | Compra flexibilidad que nadie pidió: Sima tiene dos faenas, cada una con su bodega. |

### Opción C — `enum Faena { PATILLO, KAINITA }` en los cuatro modelos

Sin FK, sin seed, sin endpoint.

| | |
|---|---|
| ✅ | Lo más barato posible. Cumple **literalmente** los tres criterios de PROD-17: las cuatro vistas registran la faena, deja de ser texto libre, el seed refleja la realidad. |
| ✅ | No toca `Branch` → cero coordinación con Benjamín. |
| ❌ | **Esquiva la pregunta de fondo en vez de responderla.** El enum y `Branch` quedan sin relación para siempre; «Faena» sigue existiendo como sucursal fantasma en el seed. |
| ❌ | Una tercera faena es una migración y un deploy, no una fila. |
| ❌ | Sin dirección, sin `isActive`, sin poder desactivar una faena cerrada. |
| ❌ | Deja a Terreno permanentemente incompatible con el selector de sucursal que el resto de la app ya usa. |

**Descartada**, aunque sea la más barata: el ticket de Producto dice explícito
que *"de esto depende si el inventario y la operación en terreno se cruzan por
la misma clave o por dos distintas"*. C congela la divergencia y cobra el
arreglo más caro después.

---

## 4. Decisión: **Opción A**

**La faena es una `Branch` de tipo `SITE`.**

**Por qué A y no C:** el *"solo Patillo y Kainita"* del cliente es el estado
actual del negocio, no una invariante del esquema. Y sobre todo: el objetivo de
PROD-17 es que Terreno e Inventario compartan clave. C no lo hace.

**Por qué A y no B:** la única ventaja real de B aparece cuando una faena se
abastece de más de una bodega, o una bodega sirve a más de una faena. Hoy es
1:1 y el cliente no ha planteado lo contrario. Y A **es reversible hacia B**:
extraer `Site` más adelante es una migración que copia las filas
`Branch(kind=SITE)` y repunta cuatro FKs — mecánico. Mantener desde el día uno
un segundo eje que nadie puebla es más caro que esa migración hipotética.

### Sub-decisiones

**D1 · Discriminador: enum `kind`, no `isSite Boolean`, con default `OFFICE`.**
Un booleano llamado `isSite` describe lo que la fila *no* es; un enum deja lugar
a un tercer valor (`WORKSHOP`, por ejemplo) sin reescribir el significado de la
columna, y se lee igual que `Equipment.status` y `Equipment.controlUnit`, que ya
usan ese patrón. El default es **`OFFICE`** a propósito: una sucursal creada
desde el CRUD sin declarar su tipo **no** debe poder recibir registros de
terreno. Si alguien crea «Faena Nueva» y olvida el `kind`, el error es visible
(*no aparece en el selector*) en vez de silencioso (*los registros se guardan en
una oficina*).

> **Se evaluó y se descartó** forzar la invariante por FK compuesta
> (`@@unique([id, kind])` en `Branch` + `(branchId, branchKind)` en cada modelo
> de Terreno, con un `CHECK`). Es expresable, pero denormaliza `kind` en cada
> fila de Terreno y convierte «cambiar el tipo de una sucursal» en una cascada.
> **La invariante la sostiene el servicio, cubierta por test.**

**D2 · `branchId` es obligatorio (`NOT NULL`) en los cuatro modelos.**
El criterio 1 de PROD-17 es que las cuatro vistas registren la faena; un campo
opcional lo deja a medias y a los tres meses la mitad de los registros no tiene
lugar. Estamos en dev y sin datos reales (mismo argumento de RFC-3), así que la
migración es directa y el seed se reescribe.

**Si al implementar ya hay datos que valga la pena conservar**, esto *no* se
resuelve con un default: hay que agregar la columna nullable, poblarla mapeando
desde `Equipment.homeBranchId`, y recién después apretarla a `NOT NULL`. Son
dos migraciones y una revisión manual de los casos que no mapeen —
presupuestarlo así.

**D3 · El campo se llama `branchId`, no `faenaId`.**
Apunta a `Branch`, y RFC-3 (D5) fijó que el modelo va en inglés. Los modelos de
Terreno siguen en español porque son de Alexander y renombrarlos es un ticket
propio, no un efecto colateral de este RFC. Queda entonces
`Hallazgo { equipoId, branchId }` — **una inconsistencia documentada y
aceptada**, no un descuido. Se resuelve cuando Terreno se renombre completo.

**D4 · La faena sale del selector, no se deriva del equipo.**
Se evaluó derivarla de `Equipment.homeBranchId` y ahorrarse el campo en el
formulario. **Se descarta:** un equipo con base en Patillo puede estar
trabajando una semana en Kainita, y derivarlo registraría el lugar equivocado
sin que nadie lo note. **La faena es una propiedad del evento, no de la
máquina.** Viaja explícita en el DTO, y la UI la toma del selector de Terreno
(T21), que lee `ui.selectedBranchId` filtrado a `kind = SITE`.

**D5 · `TrabajoExtraordinario.faena: String` se elimina.**
Sus valores sembrados (`'Rajo Norte'`, `'Rajo Sur'`) son datos de ejemplo
inventados que no corresponden a ninguna faena real, así que no hay nada que
migrar: se borra la columna y se reescribe el seed. Conservarla «por si acaso»
deja dos fuentes para el mismo hecho. Si el cliente pide después un grano más
fino que la faena, esa es la pregunta abierta de T32 (§8.2) y se responde una
vez, no con una columna de texto libre sobreviviente.

---

## 5. Modelo resultante

```prisma
enum BranchKind {
  OFFICE // Casa Matriz, oficina, bodega central. NO recibe registros de terreno.
  SITE   // Faena: Patillo, Kainita. Es donde ocurre la operación.
}

model Branch {
  // …sin cambios…
  kind BranchKind @default(OFFICE)

  // Operación en Terreno (RFC-4)
  hallazgos     Hallazgo[]
  combustibles  RegistroCombustible[]
  horometros    RegistroHorometro[]
  trabajosExtra TrabajoExtraordinario[]

  @@index([kind])
}

// Los cuatro modelos de Terreno, idéntico en los cuatro:
model Hallazgo {
  // …sin cambios…
  branchId String @map("branch_id")
  branch   Branch @relation(fields: [branchId], references: [id])
}

model TrabajoExtraordinario {
  // …sin cambios…
  // faena String  ← ELIMINADO (D5)
  branchId String @map("branch_id")
  branch   Branch @relation(fields: [branchId], references: [id])
}
```

Seed (`prisma/seed.ts`):

```ts
const BRANCHES = [
  { name: 'Casa Matriz', address: 'Iquique', kind: 'OFFICE' },
  { name: 'Patillo',     address: '…',       kind: 'SITE'   },
  { name: 'Kainita',     address: '…',       kind: 'SITE'   },
];
```

`onDelete` queda en el default (`Restrict`): un registro de terreno es
histórico y no debe desaparecer porque alguien borró una sucursal. Ver §6 por
qué eso obliga a tocar el guard de borrado.

### Alternativa de implementación descartada dentro de A

Se consideró dejar la sucursal «Faena» existente y **renombrarla** a «Patillo»,
creando solo «Kainita». Es menos ruidoso en la base, pero arrastra el stock y
los equipos que hoy cuelgan de «Faena» hacia Patillo por accidente de seed, no
por decisión. Como estamos en dev, **se reseedea limpio**.

---

## 6. Impacto

| Zona | Qué cambia |
|---|---|
| `prisma/schema.prisma` | Enum nuevo + columna en `Branch` (**dominio de Benjamín**) + FK en los cuatro modelos de Terreno (**dominio de Alexander**). Archivo compartido: avisar en el handoff. |
| `prisma/seed.ts` | `BRANCHES` pasa de 2 a 3 entradas con `kind`. Las filas de `Stock` y los registros de ejemplo de Terreno se repuntan. |
| `src/branch/dto/create-branch.dto.ts` | Acepta `kind`. **Obligatorio antes de que el frontend lo mande** (§7). |
| `src/branch/dto/query-branch.dto.ts` | Acepta `?kind=SITE`. **Mismo orden de merge** (§7). |
| `src/branch/branch.service.ts` | El guard de `remove()` cuenta hoy **solo** `homedEquipment`. Con las FKs de Terreno —y ya hoy con las de `Stock`— un borrado revienta con un `P2003` crudo sin mensaje útil. Ampliar el conteo es parte de T20. |
| `src/terreno/*/dto/` | Los cuatro DTOs de creación reciben `branchId` validado. |
| `src/terreno/*/*.service.ts` | Validación compartida: la sucursal existe, está activa y es `kind = SITE`. Un helper, no cuatro copias. |
| `src/layout/TerrenoLayout.tsx` (front) | Gana el selector de faena (T21). |
| Las 4 vistas de Terreno (front) | Mandan `branchId`. |
| **Inventario** | **Sin cambios de modelo.** Solo hay tres sucursales en vez de dos en el seed. Los tests unitarios usan fixtures literales y no se ven afectados; revisar cualquier prueba que dependa del seed. |
| `GET /api/branches` | La respuesta ya devuelve la fila completa (`findMany` sin `select`), así que `kind` sale solo. Sin cambio en el servicio de lectura. |

---

## 7. Riesgos y orden de merge

**🔴 Trampa de merge — la misma que ya nos pasó con categorías.** El backend
corre con `forbidNonWhitelisted: true`. Si el PR de frontend que manda
`?kind=SITE` a `/api/branches` entra **antes** que el PR de backend que declara
ese filtro en `QueryBranchDto`, la API responde **400** y el selector de Terreno
queda vacío. **No degrada: rompe.** Orden obligatorio:

1. **Backend (T20 · DEV-45)** — enum, migración, seed, DTOs de Terreno, filtro
   `kind` en `QueryBranchDto`, guard de borrado.
2. **Frontend (T21 · DEV-46)** — selector en `TerrenoLayout` + `branchId` en
   los cuatro formularios.

**🟡 Zona compartida.** `Branch` es de Benjamín y los modelos de Terreno son de
Alexander. Este RFC toca los dos dominios sin ser dueño de ninguno. **No se
mergea sin que Benjamín apruebe el cambio a `Branch`.** Conviene resolverlo
junto con el `Branch.isDefault` que quedó pendiente de la convergencia de RFC-3
— es la misma conversación sobre qué sabe `Branch` de sí mismo.

**🟡 Bloqueo en cadena.** T20 bloquea a T21 y, por la vía del lugar, a buena
parte de la tanda de Terreno. Mientras este RFC esté en revisión, la tanda no
avanza.

---

## 8. Preguntas abiertas

1. **¿Casa Matriz abastece a las dos faenas, o cada faena tiene su bodega?**
   Si es lo primero, A se sostiene tal cual. Si una faena llegara a abastecerse
   de dos bodegas, es el disparador para migrar a B (§4).
2. **Grano sub-faena (T32).** ¿Un hallazgo «de lugar» se identifica con texto
   libre o con una lista de sectores dentro de la faena? Pendiente con el
   cliente. Cualquiera sea la respuesta, cuelga de `branchId`.
3. **¿Se registran horómetro o combustible de equipos que están en Casa Matriz
   (en taller)?** Si la respuesta es sí, la regla `kind = SITE` los bloquea y
   hace falta un tercer valor (`WORKSHOP`) que sí acepte registros. **Preguntar
   antes de implementar la validación.**
4. **`Branch.isDefault`** — pendiente heredado de RFC-3. Revisar si sigue
   teniendo sentido ahora que las sucursales tienen tipo.

---

## 9. Plan

| Ticket | ID | Alcance |
|---|---|---|
| T20 | `DEV-45` | Backend: enum `BranchKind`, migración, seed real, `branchId` en los cuatro modelos + DTOs, validación `SITE`, filtro `kind` en `QueryBranchDto`, guard de borrado ampliado. |
| T21 | `DEV-46` | Frontend: selector de faena en `TerrenoLayout` + `branchId` en los cuatro formularios. **Mergea después de T20.** |

---

## 10. Aprobación

- [ ] **Benjamín** — cambio a `Branch` (`kind`, relaciones nuevas, guard de borrado).
- [ ] **Alexander** — FK en los cuatro modelos de Terreno y eliminación de `TrabajoExtraordinario.faena`.
- [ ] **Cliente / PO** — pregunta abierta §8.3 (equipos en taller) antes de cerrar la validación.
