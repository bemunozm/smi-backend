# Deuda de seguridad diferida — smi-backend

Contexto: la demo actual corre **solo en `localhost`** (backend y frontend en
la misma máquina de desarrollo, sin exposición a internet). Los ítems abajo
son aceptables para ese escenario y quedan **explícitamente diferidos**, no
resueltos. El disparador para resolverlos es único y claro:

> **Cualquier exposición fuera de `localhost`** — deploy a un servidor
> compartido, túnel (ngrok/cloudflared), demo remota, staging, producción —
> obliga a cerrar TODOS los ítems de esta tabla antes de exponer.

| Severidad | Ítem | Acción | Cuándo |
|---|---|---|---|
| M2 | Rate limiting en `/sign-in/email` implementado pero APAGADO por defecto fuera de producción | Setear `AUTH_RATE_LIMIT_ENABLED=true` en el `.env` del ambiente que se expone (ver `auth.ts`/`env.ts` — `customRules` ya fija 5 intentos / 60s) | Antes de exponer fuera de localhost |
| M3 | Postgres publica el puerto en `0.0.0.0:5433` | En `docker-compose.yml`, bindear a `127.0.0.1:5433:5432` | Antes de exponer fuera de localhost (o si la máquina de desarrollo comparte red) |
| B2 | Sin `helmet` | Agregar `helmet()` como middleware global en `main.ts` | Antes de exponer fuera de localhost |
| B3 | Cookies sin `useSecureCookies` / `sameSite: 'none'` para cross-domain | En `auth.ts` → `advanced.useSecureCookies: true` y `sameSite` acorde cuando frontend y backend estén en dominios distintos en prod | Cuando el frontend deje de compartir origin/red local con el backend |
| B4 | Expiración de sesión en el default de Better Auth (7 días) | Revisar `session.expiresIn`/`updateAge` según política real del negocio (ej. 8h para roles operativos en planta) | Antes de producción, junto con el equipo de producto |
| — | Credenciales seed compartidas (`Smi123456!`, incl. el usuario `admin@smi.local`) | Rotar o eliminar los 4 usuarios seed y crear cuentas reales con contraseñas únicas por persona | Antes de exponer fuera de localhost (aplica también si se comparte la máquina de desarrollo) |

## Ya resuelto en esta iteración (no diferido)

- **A1** — auto-registro público cerrado (`emailAndPassword.disableSignUp: true`); usuarios solo vía admin plugin/seed.
- **M1** — arranque falla rápido si `BETTER_AUTH_SECRET` falta o es débil (< 32 chars).
- **A2** — el seed de credenciales de desarrollo se niega a correr si `NODE_ENV=production`.
- **M4** — autorización por rol consolidada en el `@Roles()`/`AuthGuard` de `@thallesp/nestjs-better-auth` (se eliminó el guard/decorator propio en `src/common/`, que solo actuaba con `@UseGuards` manual — footgun de autorización silenciosa).
- **B1** — `ValidationPipe` global (`whitelist`+`forbidNonWhitelisted`+`transform`) agregado en `main.ts` al llegar los primeros DTOs de dominio (`UsersModule`: `CreateUserDto`/`UpdateUserDto`).
- **M2 (mecanismo implementado, revisión de seguridad de Supervisión en Terreno)** — `rateLimit` nativo de Better Auth habilitado en `auth.ts`, con `customRules` de 5 intentos / 60s para `/sign-in/email`, gobernado por `AUTH_RATE_LIMIT_ENABLED` (`env.ts`): `true` por defecto solo si `NODE_ENV=production`, `false` en cualquier otro caso para no romper el e2e suite. Sigue en la tabla de arriba porque el default FUERA de producción es apagado — hay que setearlo a mano antes de un túnel/demo remota que no corra con `NODE_ENV=production`.
- **RFC R2-storage** — los 3 archivos de **Flota** (foto de equipo, documento de equipo, foto de carga de combustible) dejaron de servirse por `/uploads/*` **sin autenticación**. Ahora viven en un bucket privado (MinIO en local, Cloudflare R2 en producción) y se sirven con una URL firmada, resuelta on-read (`StorageService.sign`) y nunca persistida — sin firma válida, el objeto no es accesible. El pendiente de Terreno que quedaba anotado acá se cerró en la Fase 3 del RFC Supervisión en Terreno — ver el ítem de abajo.
- **RFC Supervisión en Terreno, Fase 3 — cierre de `/uploads`** — se retiró por completo `UploadsController`/`UploadsModule` y el `app.useStaticAssets('/uploads/*', ...)` de `app.setup.ts`: ya no existe una ruta pública sin autenticación que sirva archivos del disco del servidor (cierra definitivamente **R2-A1** de abajo, que antes solo quedaba mitigado). Las fotos de horómetro (Módulo A) se eliminaron del flujo (spec del cliente); las fotos de Combustible/Hallazgo que YA tenían un `fotoUrl` legacy (`/uploads/...`) se siguen sirviendo tal cual en las respuestas de la API (la columna y el mapeo de lectura no se tocaron), pero el link en sí queda roto (404) porque el archivo ya no se sirve — aceptado: son datos históricos de la demo local, no de un ambiente con usuarios reales. `fotoUrl` se retiró de los DTOs de creación/edición de Combustible y Hallazgo (el frontend ya no lo enviaba en ningún flujo vivo — confirmado por grep — así que era campo muerto); cualquier intento de mandarlo ahora se rechaza con 400 (`forbidNonWhitelisted`). El folder `uploads/` en disco NO se borró (queda 1 archivo de una prueba anterior) — limpiarlo es una tarea manual aparte, sin urgencia.

## Revisión de seguridad — R2-storage (esta iteración)

Hallazgos de la revisión de las Fases 1-2 del RFC R2-storage, identificados y
cerrados en la misma rama (`feat/flota/r2-storage`). Usan su propia
numeración (prefijo `R2-`) para no chocar con la tabla de arriba, que es de
otra ronda de revisión.

- **R2-A1 (alto, pre-existente, DEFINITIVAMENTE cerrado en RFC Supervisión en
  Terreno Fase 3)** — el endpoint legacy `POST /api/uploads` (Terreno:
  horómetro/hallazgos) tomaba la extensión de `file.originalname` y filtraba
  solo por el `Content-Type` que manda el cliente — un SUPERVISOR podía subir
  un `.html`/`.svg` declarando `Content-Type: image/png` y `useStaticAssets`
  lo servía tal cual en `/uploads/*` (mismo origin que el resto de la API):
  XSS almacenado → escalación de privilegios. Primera mitigación (esta misma
  iteración, R2-storage): validar bytes reales (`detectFileSignature`, igual
  que `/api/files`), generar el nombre server-side (nunca la extensión del
  cliente) y agregar `X-Content-Type-Options: nosniff` + `Content-Security-
  Policy: default-src 'none'; sandbox` + `Content-Disposition: attachment` en
  no-imágenes (PDF) a `/uploads/*`. Cierre definitivo (RFC Supervisión en
  Terreno, Fase 3): se retiró por completo `UploadsController`/
  `UploadsModule` y `app.useStaticAssets(...)` — ya no existe la ruta.
- **R2-M2 (medio, cerrado)** — multipart hardening: `limits` explícitos
  (`files:1, fields:0, parts:1, fieldNameSize:50, headerPairs:20`) en los
  endpoints multipart (`/api/files` y `/api/ocr/fuel-reading` — `/api/uploads`
  se retiró por completo en el cierre de R2, RFC Supervisión en Terreno Fase
  3, ver el ítem de arriba; el límite que tenía ahí murió con la ruta) —
  confirmado que el frontend (`uploadFile`/`uploadImage`/`fuelReadingOcr`)
  manda ÚNICAMENTE la parte `file` en los casos vigentes, así que estos
  límites no rompen ningún flujo real. Además,
  `multer` traía 3 CVE altas (GHSA-wc9g-mqfw-jrwm, GHSA-535w-7cp7-47q4,
  GHSA-qfvm-cv95-jqjf, todas `<2.3.0`) por venir empaquetado con
  `@nestjs/platform-express@11.1.28` → se bumpeó a `^11.2.6` (trae
  `multer@2.4.0`, patcheado), peer-compatible con `@nestjs/core`/`common`
  ya instalados (`11.1.28`, sin tocarlos).
- **R2-B1 (bajo, cerrado)** — bug de rollback en
  `EquipmentService.create`/`update`: el shaping (`withUsageFields`, que
  incluye `StorageService.sign`) corría DENTRO del `try` junto con el
  `create`/`update` de Prisma — si el shaping fallaba DESPUÉS de que el
  commit en BD ya se hizo, el `catch` igual descartaba `finalKey` (la key ya
  persistida en la fila) y, en `update`, ya se había borrado la foto vieja:
  el equipo quedaba apuntando a un objeto inexistente en el bucket. Se
  restructuró para que el `try/catch` cubra SOLO la escritura Prisma; el
  borrado de la key vieja y el shaping van después, fuera del `try`. Mismo
  patrón aplicado en `EquipmentDocumentService` y `CombustibleService`
  (antes seguros solo por accidente: `return this.shape(...)` sin `await`
  dentro del `try`, que en los hechos ya sacaba la promesa del alcance del
  `catch` — se dejó explícito para no depender de ese detalle).
- **R2-B2 (bajo, cerrado)** — `StorageService.onModuleInit` ahora loguea un
  `warn` explícito cuando las credenciales efectivas de storage son las de
  desarrollo (MinIO local) y `NODE_ENV !== 'production'`, para que no pase
  desapercibido en un despliegue real que olvidó setear `NODE_ENV=production`
  + `STORAGE_*`. Documentado en `.env.example`/`README.md` que
  `NODE_ENV=production` es OBLIGATORIO en el VPS (no se tocó `start:prod`,
  queda fuera de alcance).
- **R2-B3 (bajo, cerrado, código de Terreno; superado en RFC Supervisión en
  Terreno Fase 3)** — `fotoUrl` en `CreateCombustibleDto`/
  `UpdateCombustibleDto` aceptaba cualquier string: una URL externa se podía
  guardar y se renderizaba tal cual como `<img src>` en el listado — un
  tracking pixel disfrazado de foto de carga. La mitigación original
  (`@Matches(/^\/uploads\/[\w.-]+$/)` + `@MaxLength(300)`) quedó obsoleta: al
  cerrar R2 (Fase 3) se retiró `/api/uploads` por completo y `fotoUrl` dejó
  de ser un campo aceptado en esos DTOs (ver el ítem "cierre de `/uploads`"
  de arriba) — con `forbidNonWhitelisted` global, mandarlo ahora es 400. La
  columna y el mapeo de LECTURA siguen intactos para no romper filas
  históricas, pero ya no hay forma de escribir un `fotoUrl` nuevo, así que el
  hallazgo original queda cerrado por eliminación del vector, no por el
  regex.

### Deuda nueva que queda diferida

- **Archivos legacy de Flota en disco** — las URLs `/uploads/...` de ANTES
  de esta migración quedan en disco sin copiar al bucket: la migración
  (`20260924125213_flota_file_keys`) solo limpia las columnas, no mueve
  bytes. Hoy es inofensivo (1 solo archivo local, sin data de producción),
  pero cualquier ambiente con datos reales necesita un script de copia a
  bucket (o un borrado consciente) ANTES de aplicar esa migración.
- **Riesgo de huérfano por updates concurrentes (conocido, no cerrado)** —
  dos `PATCH` concurrentes sobre el mismo equipo/documento/registro,
  reemplazando el mismo `photoKey`/`fileKey`, pueden dejar huérfano el
  objeto del que "pierde" la carrera (last-write-wins a nivel de fila, sin
  lock). No se dio en el flujo normal (un usuario, un formulario) pero es un
  gap conocido. Follow-up: lock optimista (precondición por `updatedAt`) o
  un sweeper periódico que barra objetos sin referencia en BD.
- **Sin rate limiting en `POST /api/files`** — extiende la deuda M2 de la
  tabla de arriba, hoy acotada a `/sign-in/email`.
- **EXIF sin despojar en fotos subidas** — las fotos de combustible (y
  cualquier imagen subida vía `/api/files`) no despojan metadata EXIF (GPS)
  antes de guardarse — podrían filtrar la ubicación exacta de la carga sin
  que el operador lo note. Acción futura: strip EXIF server-side antes de
  `StorageService.putTmp`.

### Deuda nueva — revisión de seguridad de Supervisión en Terreno (esta iteración)

- **Sin tope al delta entre `valorInicial`/`valorFinal`** — `B3` acotó
  `valorInicial`/`valorFinal`/`fuelLiters` a rangos absolutos
  (`@Min`/`@Max`), pero no hay un tope a la DIFERENCIA entre ambos dentro de
  una misma tarjeta (ej. una tarjeta que "avanza" 500.000 horas en un turno
  sigue pasando la validación si ambos valores están dentro de rango). Fuera
  de alcance de esta ronda — decisión del tech lead. Follow-up: un
  `@Max` relativo (`valorFinal - valorInicial <= N`) en el DTO de cierre, o
  un chequeo explícito en `ShiftsService.closeCard`.
- **Render del PDF de reporte de salida en el hilo principal** — `pdfmake`
  (`renderPdfBuffer`) corre síncrono dentro del request handler de
  `ShiftReportsService.create`. Con pocos reportes por turno (tope M2, 3 cada
  10 min) el bloqueo del event loop es marginal hoy, pero si el volumen de
  Supervisión en Terreno crece (más supervisores, más tarjetas por reporte),
  mover el render a un `worker_thread` evita que un PDF grande bloquee otras
  requests concurrentes.
- **Fotos de combustible visibles a cualquier rol vía `GET /api/combustible`**
  — decisión de producto PRE-EXISTENTE (no introducida por esta ronda),
  marcada acá para que quede escrita: a diferencia de `Operator.rut` (B4a,
  restringido a ADMIN/SUPERVISOR) o de las tarjetas de turno (todo el módulo
  es SUPERVISOR/ADMIN), el listado de cargas de combustible —con la URL
  firmada de la foto— es legible por cualquier sesión autenticada, incluido
  MANTENEDOR. Si el negocio decide que debería restringirse, es un cambio de
  alcance nuevo, no un bug de esta revisión. (Nota: el rol OPERADOR de esta
  nota original se eliminó — RFC Supervisión en Terreno, anexo "el operador
  deja de ser usuario de la plataforma", 28/09 — el operador ya no es una
  sesión de plataforma.)
- **`name` propio editable si `/update-user` se vuelve a habilitar** — B5
  deshabilitó `/update-user` (self-service, sin usar por el frontend hoy).
  Si en el futuro se habilita para que un usuario edite su propio nombre,
  hay que sumarle el mismo truncado a 120 chars que
  `ShiftReportsService.create` le aplica a `supervisorName` — si no, un
  nombre absurdamente largo vuelve a poder deformar el PDF/asunto de correo
  por ese camino.

## TUNNEL CHECKLIST — antes de exponer el dev server por un túnel HTTPS

Ítems específicos para la prueba en tablet vía túnel (ngrok/cloudflared,
ver el RFC "Supervisión en Terreno", Riesgo 1). Se suma a — no reemplaza —
la tabla de deuda diferida de arriba, que sigue aplicando completa.

- [ ] Rotar o eliminar las contraseñas de los usuarios seed (`Smi123456!`,
      incluido `admin@smi.local`) — ver la fila de credenciales seed en la
      tabla de arriba. Mecanismo: `scripts/set-password.ts`
      (`NEW_PASSWORD=... npm run user:set-password -- --email <email>`) —
      hashea igual que Better Auth, actualiza la cuenta `credential` y
      revoca las sesiones vigentes del usuario. La contraseña se pasa SIEMPRE
      por la env var `NEW_PASSWORD`, nunca como argumento (no queda en el
      historial de shell).
- [ ] `SHIFT_REPORT_EXTRA_RECIPIENTS` con el correo de Sergio Torres
      (pendiente de confirmar con el cliente) — sin esto, el reporte de
      salida de turno solo llega a los usuarios ADMIN (ver `.env.example`).
- [ ] `AUTH_RATE_LIMIT_ENABLED=true` en el `.env` del proceso que se expone
      (el default es `false` fuera de `NODE_ENV=production` — ver M2 arriba).
- [ ] Cookies seguras detrás de HTTPS: `advanced.useSecureCookies: true` en
      `auth.ts` (túnel HTTPS = cumple el requisito de `Secure`; sin esto el
      browser puede rechazar la cookie de sesión sobre el túnel).
- [ ] `trustedOrigins`/`FRONTEND_URL` exactos: el dominio del túnel (ej.
      `https://xxxx.trycloudflare.com`), no un comodín ni `localhost`.
- [ ] Postgres bindeado a `127.0.0.1` (`docker-compose.yml`, ver M3 arriba) —
      el túnel expone el backend, no la base de datos, pero si la misma
      máquina está en una red compartida esto importa igual.
