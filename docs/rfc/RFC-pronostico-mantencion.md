# RFC — Fecha estimada de la próxima mantención por uso promedio (SMI)

| Campo                   | Valor                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| **Autor**               | Joaquín                                                                                        |
| **Dominio**             | Mantenimiento                                                                                  |
| **Pedido**              | «Revisar el tema de aviso de mantención por uso promedio» (reunión con el cliente, 24/10/2026) |
| **Alcance de este RFC** | Etapa 1: **solo mostrar** la fecha estimada y el día sugerido                                  |
| **Estado**              | Aprobado por Joaquín el 24/10/2026 (en conversación)                                           |
| **Coordina con**        | Alexander (tablero del taller: no se toca en esta etapa)                                       |

## 1. Problema

La app ya avisa cuando un equipo entra en su margen (50 h antes en los pesados, 1.000 km antes en los livianos),
pero nadie sabe **qué día** va a llegar a la mantención. El cliente quiere verlo con anticipación para planificar,
y elegir el día en que el equipo menos se usa.

- **Pesados:** se miden en **horas máquina** (horómetro, `currentHourmeter`). La próxima mantención la da su pauta.
- **Livianos:** se miden en **kilómetros** (odómetro, `currentMileage`). La próxima mantención es el siguiente múltiplo de 10.000 km
  (o su pauta, si tuviera una).

## 2. De dónde sale el uso

Las tarjetas de turno (`RegistroHorometro`) ya guardan cada lectura con su hora: el valor inicial al abrir y el final al cerrar,
en horas para los pesados y en km para los livianos. No hace falta ninguna tabla nueva.

## 3. Opciones

### Opción A — Sumar lo trabajado en cada tarjeta

Uso diario = suma de `final − inicial` de las tarjetas cerradas ÷ días.

- ✅ Simple.
- ❌ Pierde el uso que ocurre sin tarjeta (una camioneta que se mueve entre dos tarjetas, un equipo que se registra un día sí y otro no).

### Opción B — Avance del contador en el tiempo ✅ (elegida)

Uso diario = (lectura más alta de las últimas 4 semanas − la primera de esa ventana) ÷ días desde esa primera lectura hasta hoy.

- ✅ Mide el avance real del horómetro u odómetro, con o sin tarjeta entre medio.
- ✅ Cuenta los días sin uso: refleja el ritmo real (una camioneta que sale 3 días por semana).
- ❌ Necesita al menos 7 días de lecturas; antes de eso se muestra «faltan datos».

### Opción C — Modelo estadístico o de aprendizaje automático

- ❌ Desproporcionado para el volumen de datos y difícil de explicar al cliente. Descartada.

### Día sugerido

El reparto por día de la semana sí sale de las tarjetas (Opción A aplicada solo al perfil): con 3 semanas o más de historial,
se sugiere el día de la semana de menos uso dentro de los 7 días previos a la fecha estimada.
Sin historial suficiente, se muestra solo «la semana del …».

## 4. Decisión

- Fecha estimada = hoy + ⌈lo que falta ÷ uso diario⌉. Se calcula al pedirla; **no se guarda nada**.
- Estados: `ESTIMADA`, `TOCA_AHORA` (ya no falta nada), `FALTAN_DATOS` (menos de 7 días de lecturas),
  `SIN_USO` (el contador no avanzó en 4 semanas), `LEJANA` (más de un año).
- Fuera de servicio no se estima. Las lecturas marcadas como menores a la anterior (`belowPreviousReading`) no cuentan.
- Endpoints: `GET /api/maintenance-forecast` (todos) y `GET /api/maintenance-forecast/:equipmentId`.
  Lo leen ADMIN, MANTENEDOR y SUPERVISOR, igual que la pauta.
- Se muestra en: la lista de Equipos, la ventana de la pauta / «Mantención del liviano», y el calendario de vencimientos
  de los livianos (que hasta ahora solo decía «faltan X km»).

## 5. Fuera de alcance (etapa 2, a validar con el cliente)

- Un mínimo de **7 días de anticipación** para crear la orden preventiva, además del margen de h/km: haría que la tarjeta
  de un pesado de mucho uso llegue antes al taller. **Cambia el tablero de Alexander**: no se hace sin el visto bueno del cliente.
- Agendar o comprometer la fecha.

## 6. Riesgos

- Equipos sin lecturas (aparecen «Sin lectura» en la ficha): no se pueden estimar hasta que registren uso.
- Una lectura mal tipeada hacia arriba infla el promedio: se acota con `belowPreviousReading` en la siguiente y con la
  ventana de 4 semanas, que la olvida sola.
