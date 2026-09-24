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
| M2 | Sin rate limiting en `/sign-in/email` | Habilitar `rateLimit` en `auth.ts` con `customRules` estricto para `/api/auth/sign-in/email` (p. ej. 5 intentos / 60s) — ver skill `better-auth-security-best-practices` | Antes de exponer fuera de localhost |
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
- **RFC R2-storage** — los 3 archivos de **Flota** (foto de equipo, documento de equipo, foto de carga de combustible) dejaron de servirse por `/uploads/*` **sin autenticación**. Ahora viven en un bucket privado (MinIO en local, Cloudflare R2 en producción) y se sirven con una URL firmada, resuelta on-read (`StorageService.sign`) y nunca persistida — sin firma válida, el objeto no es accesible. Sigue pendiente (fuera de alcance de este RFC): **Terreno (horómetro/hallazgos)** sigue subiendo y sirviendo sus fotos por `/api/uploads` + `/uploads/*`, público sin autenticación — mismo disparador de la tabla de arriba (cualquier exposición fuera de `localhost` obliga a cerrarlo antes).

## Revisión de seguridad — R2-storage (esta iteración)

Hallazgos de la revisión de las Fases 1-2 del RFC R2-storage, identificados y
cerrados en la misma rama (`feat/flota/r2-storage`). Usan su propia
numeración (prefijo `R2-`) para no chocar con la tabla de arriba, que es de
otra ronda de revisión.

- **R2-A1 (alto, pre-existente, cerrado)** — el endpoint legacy `POST
  /api/uploads` (Terreno: horómetro/hallazgos) tomaba la extensión de
  `file.originalname` y filtraba solo por el `Content-Type` que manda el
  cliente — un SUPERVISOR podía subir un `.html`/`.svg` declarando
  `Content-Type: image/png` y `useStaticAssets` lo servía tal cual en
  `/uploads/*` (mismo origin que el resto de la API): XSS almacenado →
  escalación de privilegios. Cerrado: ahora valida bytes reales
  (`detectFileSignature`, igual que `/api/files`), genera el nombre
  server-side (nunca la extensión del cliente) y `/uploads/*` agrega
  `X-Content-Type-Options: nosniff` + `Content-Security-Policy: default-src
  'none'; sandbox` + `Content-Disposition: attachment` en no-imágenes (PDF).
  **Sigue pendiente** (fuera de alcance de este cierre): Terreno sigue
  sirviendo `/uploads/*` sin autenticación — el follow-up real es migrar
  Terreno a `POST /api/files` (bucket privado + URL firmada), como ya hace
  Flota.
- **R2-M2 (medio, cerrado)** — multipart hardening: `limits` explícitos
  (`files:1, fields:0, parts:1, fieldNameSize:50, headerPairs:20`) en los 3
  endpoints multipart (`/api/files`, `/api/uploads`,
  `/api/ocr/fuel-reading`) — confirmado que el frontend (`uploadFile`/
  `uploadImage`/`fuelReadingOcr`) manda ÚNICAMENTE la parte `file` en los
  tres casos, así que estos límites no rompen ningún flujo real. Además,
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
- **R2-B3 (bajo, cerrado, código de Terreno)** — `fotoUrl` en
  `CreateCombustibleDto`/`UpdateCombustibleDto` aceptaba cualquier string:
  una URL externa se podía guardar y se renderizaba tal cual como `<img
  src>` en el listado — un tracking pixel disfrazado de foto de carga. Se
  restringió con `@Matches(/^\/uploads\/[\w.-]+$/)` + `@MaxLength(300)`.

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
