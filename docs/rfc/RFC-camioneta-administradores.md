# RFC — Qué administradores usan camioneta (SMI)

| Campo                   | Valor                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| **Autor**               | Joaquín                                                                                    |
| **Dominio**             | Usuarios · Flota (livianos)                                                                |
| **Pedido**              | Dejar solo a Sergio Torres, entre los administradores, para usar los livianos (12/11/2026) |
| **Estado**              | Aprobado por Joaquín el 12/11/2026 (en conversación): opción A                             |
| **Toca**                | `schema.prisma` (tabla `user`, de Better Auth): avisar al equipo                           |

## 1. Problema

Desde bemunozm/smi-backend#80, un liviano se puede asignar a un administrador, y cualquier
administrador ve «Mi camioneta» en el menú. Hay cuatro administradores (Benjamín, Alexander,
Sergio, María), pero solo Sergio se mueve en camioneta por faena. Los otros tres aparecen igual
en «Asignado a» y tienen una pantalla que no usan.

Hoy el usuario solo tiene nombre, correo y rol: no hay ningún dato que distinga a Sergio.

## 2. Opciones

### Opción A — Campo `usesLightVehicle` en el usuario, editable desde Usuarios

- Columna booleana `uses_light_vehicle` en `user`, `false` por defecto. Se declara también en
  `user.additionalFields` de Better Auth, para que el CLI no la pierda si regenera el modelo y para
  que llegue en `session.user`.
- En **Usuarios**, al editar un administrador, aparece la casilla «Usa camioneta».
- **Asignado a**, en un liviano, muestra solo a los administradores con la casilla marcada. El
  backend rechaza asignar un liviano a un administrador sin la casilla.
- El menú muestra **«Mi camioneta»** solo al administrador con la casilla.
- Supervisores, mantenedores y prevencionistas no cambian: los cuatro roles siguen igual que hoy.

**A favor:** lo maneja el propio administrador desde la pantalla, se ve por qué los demás no
aparecen y sirve si mañana otro administrador empieza a usar camioneta.
**En contra:** migración en una tabla de Better Auth.

### Opción B — Lista de correos en la configuración del servidor

- Variable de entorno, por ejemplo `LIGHT_VEHICLE_ADMIN_EMAILS=sergio@…`.

**A favor:** rápida, sin migración.
**En contra:** cada cambio requiere a alguien con acceso al despliegue, y en pantalla no se ve por
qué un administrador no aparece. El menú tampoco lo sabría sin otra consulta.

## 3. Decisión

**Opción A.** El dato es de negocio («esta persona usa camioneta»), no de infraestructura, y
quien lo cambia es el administrador, no quien despliega.

## 4. Detalle

- Migración `user_uses_light_vehicle`:
  `ALTER TABLE "user" ADD COLUMN "uses_light_vehicle" BOOLEAN NOT NULL DEFAULT false`.
- `PATCH /api/users/:id` acepta `usesLightVehicle` (solo ADMIN). Se escribe con Prisma: no es
  credencial ni rol, que siguen pasando por `auth.api`.
- `GET /api/users` lo incluye en la respuesta.
- `PATCH /api/equipment/:id/assignment`: en un liviano, un `ADMIN` sin la casilla responde 400.
- La ruta `/mi-camioneta` sigue abierta a todo ADMIN (no rompe un enlace guardado); lo que cambia
  es que solo la ve en el menú quien tiene la casilla.

## 5. Riesgos

- **Despliegue:** con la migración y los dos PRs, Sergio no aparece en «Asignado a» hasta que
  alguien le marque la casilla. Hay que marcarla justo después de desplegar.
- **Asignaciones vigentes:** un liviano ya asignado a un administrador sin la casilla sigue
  asignado. Solo se valida al asignar de nuevo.
