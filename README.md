<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

API REST del **Sistema de Mantenimiento e Inventario (SMI)**. Ver `CLAUDE.md`
para la arquitectura y convenciones, y `CONTRIBUTING.md` para el flujo de
trabajo del equipo.

## Setup local

```bash
# Postgres + MinIO (storage de archivos de Flota). SIEMPRE con nombres
# explícitos: un `docker compose up` a secas puede chocar con contenedores
# de otro proyecto local (ver comentario en docker-compose.yml).
docker compose up -d postgres
docker compose up -d minio minio-init   # ⚠️ NUNCA "docker compose up -d" sin nombres

cp .env.example .env   # ajustar; genera BETTER_AUTH_SECRET con: openssl rand -base64 32
npm install
npx prisma migrate dev
npm run db:seed        # 4 usuarios: <rol>@smi.local / Smi123456!  (solo dev)
npm run start:dev      # API en http://localhost:3000  (rutas bajo /api)
```

Sin las vars `STORAGE_*` en tu `.env`, el backend cae a los defaults del
MinIO de `docker-compose.yml` (bucket `smi-files`, credenciales de
desarrollo) — no hace falta configurarlas para levantar en local. Ver
`.env.example` para el detalle de cada variable y sus equivalentes en
Cloudflare R2 (producción).

Consola web de MinIO: http://localhost:9001 (usuario/clave: ver
`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` en `docker-compose.yml`).

OCR de litros en desarrollo: el backend le pega por HTTP al worker Python
(default `http://localhost:8010`). Sin worker, el backend arranca igual y las
lecturas devuelven `UNREADABLE`. Para probarlo: `cd ocr-python && python
worker.py` (ver `ocr-python/README.md`).

## Stack y despliegue con Docker

### Stack real

- **API**: NestJS 11 + TypeScript estricto, Node 22.
- **Base de datos**: PostgreSQL 16 con Prisma 6.19 (24 migraciones; ninguna
  usa `CREATE EXTENSION`). Prisma 7 rompe el patrón `env(DATABASE_URL)`: no
  actualizar.
- **Auth**: Better Auth (plugin `admin`, roles propios, sin auto-registro).
- **Storage de archivos**: bucket S3-compatible privado con URL firmada —
  Cloudflare R2 en producción, MinIO en desarrollo.
- **OCR de litros**: un worker Python aparte (`ocr-python/worker.py`, servidor
  HTTP solo con stdlib) que corre un ensemble de dos modelos con ONNX Runtime
  en CPU: Florence-2-base fine-tuneado (int8: vision, encoder y decoder) +
  CRNN-CTC. Modelos `litros-v1`, 6 archivos, ~287 MB, verificados por
  sha256 contra `ocr-python/models.manifest.json` al arrancar. Detalle del
  pipeline, protocolo y benchmark en `ocr-python/README.md`.

El backend llama al worker por HTTP (`OCR_WORKER_URL`). Si el worker no está
listo (cargando modelos, caído, timeout) la lectura devuelve `UNREADABLE` y el
usuario tipea a mano: el backend nunca falla ni se bloquea por el OCR.

### Por qué hay dos compose

- `docker-compose.yml` es de **desarrollo** y el equipo lo usa así: Postgres
  publicado en `:5433` con credenciales fijas, más MinIO.
- `docker-compose.prod.yml` es de **producción**: sin puertos de base de datos,
  credenciales desde `.env`, límites de recursos, sin MinIO (R2) y con el
  backend y el worker OCR como imágenes propias. No reemplaza al anterior.
- `docker-compose.port.yml` es un override del despliegue **manual** (sin
  Dokploy): solo publica el backend en `127.0.0.1:${BACKEND_HOST_PORT:-3100}`.
- `docker-compose.bench.yml` es un override que solo agrega el benchmark.

Usar siempre `-p <proyecto>`: en una máquina de desarrollo pueden existir
contenedores de otros proyectos con nombres que chocarían.

### Servicios (`docker-compose.prod.yml`)

| Servicio | Imagen | Notas |
|---|---|---|
| `postgres` | `postgres:16` | Volumen con nombre, `pg_isready`. **Sin puertos publicados.** |
| `migrate` | `Dockerfile` target `migrate` | `prisma migrate deploy`, corre y termina (`restart: "no"`). |
| `ocr-worker` | `ocr-python/Dockerfile` target `prod` | Modelos montados de solo lectura. Sin puertos publicados. Límite 1.5G / 2.0 CPU. `restart: unless-stopped`. |
| `backend` | `Dockerfile` target `runtime` | Límite 768M. Solo `expose: 3000`: no publica puertos en el host (Traefik de Dokploy lo enruta; en modo manual, `docker-compose.port.yml` lo publica en `127.0.0.1`). |

Orden de arranque: `postgres` healthy → `migrate` termina con 0 → `backend`.
El backend solo espera que `ocr-worker` *arranque*, no que esté listo
(degrada si no lo está). Las migraciones son automáticas en cada `up`.

Límites: el worker OCR consume ~790 MB en régimen en el VPS ARM64 con 2 CPU
(medido, ver `ocr-python/README.md`) y el backend ~90-160 MB en reposo; los
topes dejan margen sin que una fuga en uno afecte a los demás. El worker tiene
2 CPU porque corre 2 hilos de ONNX Runtime: con 1.5 el cgroup lo frenaba y cada
foto tardaba ~2 s en ARM en vez de ~1.4 s. Un worker colgado en una lectura
(> `OCR_READ_WATCHDOG_SECONDS`) sale solo con código distinto de 0 y Docker lo
reinicia: el compose sin swarm no reinicia contenedores solo por `unhealthy`.

Redes: `internal` (sin salida a internet: Postgres, worker OCR, migrate y
backend) y `edge` (solo el backend, que sale a R2/SMTP). Al desplegar, Dokploy
le suma al backend su red de proxy (`dokploy-network`) y los labels de Traefik.

### Puertos y acceso

El stack de producción **no publica ningún puerto en el host**: el backend solo
hace `expose: 3000`. Con Dokploy, Traefik (80/443) lo enruta por dominio (ver
"Despliegue con Dokploy"). En el host el 3000 queda reservado para el panel de
Dokploy.

### Despliegue con Dokploy

Es el modo habitual. El dominio es `https://smi.evonova.cl`: el frontend en `/`
(otra app de Dokploy) y este backend en `/api`. Dokploy clona el repositorio en
`/etc/dokploy/compose/<appName>/code`, escribe ahí el `.env` con las variables
de la app y ejecuta
`docker compose -p <appName> --env-file .env -f docker-compose.prod.yml up -d --build --remove-orphans`
en el propio VPS (ARM64, ver "Nota ARM64").

1. **Crear la app**: en un proyecto de Dokploy, servicio tipo **Compose** con
   origen **Git**: repositorio `https://github.com/bemunozm/smi-backend.git`,
   rama `main`, archivo `./docker-compose.prod.yml`. Método de despliegue:
   **Docker Compose** (no Stack).
2. **`appName`**: Dokploy le agrega un sufijo aleatorio al crear la app
   (`smi-xxxxxx`) y no permite cambiarlo después. El proyecto de compose se
   llama así, y el volumen de Postgres también: `<appName>_postgres_data`. Al
   eliminar la app en Dokploy, no marcar el borrado de volúmenes sin un
   respaldo de la base (ver "Respaldo y migración de la base").
3. **NO activar "Isolated Deployments"**: el compose ya define sus redes
   (`internal`, `edge`) y Dokploy suma la de su proxy solo al servicio con
   dominio.
4. **Dominio** (pestaña Domains), asociado al servicio `backend`:
   - Host: `smi.evonova.cl`
   - Path: `/api`, **sin "Strip Path"** (el backend ya sirve bajo `/api`)
   - Container port: `3000`
   - HTTPS activado, certificado **Let's Encrypt**

   Dokploy inyecta en `backend` los labels de Traefik y las redes
   `dokploy-network` + `default`; no hay que declararlos en el compose.
5. **Modelos OCR** (no van en git): copiarlos una vez al host y apuntar
   `OCR_MODELS_HOST_DIR` ahí; es un bind mount absoluto que Dokploy no borra.

   ```bash
   scp -r ocr-python/models/ usuario@IP_DEL_VPS:/opt/smi/ocr-models/
   ```
6. **Variables** (pestaña Environment; Dokploy la escribe como `.env` y la
   interpolación `${VAR:?msg}` del compose sigue exigiendo las obligatorias):

   ```dotenv
   # Obligatorias
   POSTGRES_PASSWORD=<openssl rand -hex 24>
   BETTER_AUTH_SECRET=<openssl rand -base64 32>
   BETTER_AUTH_URL=https://smi.evonova.cl
   FRONTEND_URL=https://smi.evonova.cl
   STORAGE_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
   STORAGE_BUCKET=<bucket>
   STORAGE_ACCESS_KEY_ID=<key>
   STORAGE_SECRET_ACCESS_KEY=<secret>
   STORAGE_REGION=auto
   # Modelos OCR (ruta absoluta del host)
   OCR_MODELS_HOST_DIR=/opt/smi/ocr-models
   # Opcionales (tienen default; ver "Variables")
   # POSTGRES_USER, POSTGRES_DB, OCR_THREADS, OCR_READ_WATCHDOG_SECONDS,
   # AUTH_RATE_LIMIT_ENABLED, AUTH_IP_ADDRESS_HEADERS, STORAGE_PUBLIC_ENDPOINT,
   # STORAGE_SIGNED_URL_TTL_SECONDS, SMTP_*, SHIFT_REPORT_EXTRA_RECIPIENTS
   ```
   `POSTGRES_PASSWORD` va embebida en la URL de conexión: usar solo caracteres
   seguros para URL. `BACKEND_HOST_PORT` no aplica con Dokploy.
7. **Deploy**. El servicio `migrate` aplica las migraciones en **cada**
   despliegue, antes de que arranque el backend. Comprobar con
   `https://smi.evonova.cl/api/health`.

La IP real del cliente (rate limit de login) llega por `X-Forwarded-For`:
Traefik lo reescribe cuando el origen no es de confianza. Ver
`AUTH_IP_ADDRESS_HEADERS` en "Variables".

**Primer admin con Dokploy**: en el VPS, desde el directorio donde Dokploy
clonó el repositorio (ahí está el `.env` que escribe, y compose lo lee solo):

```bash
cd /etc/dokploy/compose/<appName>/code
read -rsp "Password: " ADMIN_PASSWORD; export ADMIN_PASSWORD
export ADMIN_EMAIL=admin@empresa.cl ADMIN_NAME="Nombre Apellido"
docker compose -f docker-compose.prod.yml -p <appName> run --rm \
  -e ADMIN_EMAIL -e ADMIN_NAME -e ADMIN_PASSWORD migrate npm run user:create-admin
unset ADMIN_PASSWORD
```

Si se lanza desde un script por SSH, agregar `< /dev/null` al final del
comando: `docker compose run` consume la entrada estándar y se tragaría el
resto del script (o las líneas que siguen en la sesión).

#### Respaldo y migración de la base

Respaldo (formato custom, se restaura con `pg_restore`):

```bash
cd /etc/dokploy/compose/<appName>/code
docker compose -f docker-compose.prod.yml -p <appName> exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > /root/backups/smi-$(date +%Y%m%d-%H%M%S).dump
```

Para pasar una base existente a un proyecto de compose con otro nombre (por
ejemplo, del despliegue manual `-p smi` a la app de Dokploy), antes del primer
deploy de la app y con el stack anterior detenido (`down` sin `-v`), se crea el
volumen del proyecto nuevo con las etiquetas de compose y se copian los datos
tal cual:

```bash
docker volume create \
  --label com.docker.compose.project=<appName> \
  --label com.docker.compose.volume=postgres_data \
  <appName>_postgres_data
docker run --rm -v smi_postgres_data:/from:ro -v <appName>_postgres_data:/to \
  alpine cp -a /from/. /to/
```

Las etiquetas hacen que compose lo adopte como propio, sin el aviso de volumen
externo. Ambas bases tienen que ser de la misma versión mayor de Postgres (16).

### Despliegue manual con túnel SSH (alternativa)

Sin Dokploy se usa el override `docker-compose.port.yml`, que publica el
backend solo en `127.0.0.1:${BACKEND_HOST_PORT:-3100}` (el 3000 del host queda
para el panel de Dokploy; dentro del contenedor el backend sigue en el 3000).
Desde un PC, por túnel SSH (con `BETTER_AUTH_URL="http://localhost:3100"` en
el `.env`):

```bash
ssh -L 3100:127.0.0.1:3100 usuario@IP_DEL_VPS
# luego http://localhost:3100/api/health
```

Exponerlo a internet exige un reverse proxy con TLS delante (ver
`SECURITY-NOTES.md`). `scripts/bench-ocr.sh` y los demás scripts no usan el
puerto del host: funcionan igual en ambos modos.

### Nota ARM64

El VPS objetivo es **Linux ARM64** (Hetzner CAX21, Ubuntu 24.04). Las imágenes
se construyen **en el propio VPS** (`up --build`), nunca en un PC x86: así
Prisma genera el motor de consultas para ARM y no hay cross-compile. Todas las
dependencias tienen variante `aarch64`: las imágenes base (`node:22-bookworm-slim`,
`python:3.12-slim-bookworm`, `postgres:16`) y las ruedas de
`ocr-python/requirements.txt` (`manylinux aarch64`, cp312). **No usar Alpine**
para el worker: `onnxruntime` no publica ruedas musl. Si algún día se construye
en CI en otra arquitectura que la de destino, agregar `binaryTargets` a
`schema.prisma` (ver el comentario del `Dockerfile`).

### Puesta en marcha manual en el VPS

Solo para el modo manual (con Dokploy, ver arriba).

```bash
# 1. Variables: copiar .env.example a .env y completar la sección "Docker de produccion"
cp .env.example .env

# 2. Modelos OCR (no van en git): desde el PC, copiar los 6 archivos
scp -r ocr-python/models/ usuario@IP_DEL_VPS:/opt/smi/ocr-models/
#    y en .env:  OCR_MODELS_HOST_DIR=/opt/smi/ocr-models
#    (el worker verifica su sha256 contra models.manifest.json al arrancar)

# 3. Construir (en el VPS) y levantar
docker compose -f docker-compose.prod.yml -f docker-compose.port.yml -p smi up -d --build
docker compose -f docker-compose.prod.yml -f docker-compose.port.yml -p smi ps
curl http://127.0.0.1:3100/api/health
```

Mientras no exista el bucket de Cloudflare R2, completa las `STORAGE_*` con
valores placeholder: el backend arranca con un aviso ("No se pudo verificar el
bucket") y solo fallan las funciones de archivos de Flota. Ver `.env.example`.

### Primer admin

`prisma/seed.ts` se niega con `NODE_ENV=production` (y borra datos) y
`user:set-password` solo rota la contraseña de un usuario existente, así que el
primer ADMIN se crea con `scripts/create-admin.ts`, desde el contenedor
`migrate` (trae `ts-node` y el mismo entorno que el backend). Las credenciales
van por entorno, nunca por argumentos:

```bash
read -rsp "Password: " ADMIN_PASSWORD; export ADMIN_PASSWORD
export ADMIN_EMAIL=admin@empresa.cl ADMIN_NAME="Nombre Apellido"
docker compose -f docker-compose.prod.yml -p smi run --rm \
  -e ADMIN_EMAIL -e ADMIN_NAME -e ADMIN_PASSWORD migrate npm run user:create-admin
unset ADMIN_PASSWORD
```

Se **niega** si ya existe algún ADMIN (seguro de repetir); los demás usuarios
se crean desde la app. Contraseña mínima: 8 caracteres.

### Benchmark del OCR (RAM y tiempo por foto)

```bash
# fotos en ./_inbox/total_surtidor (o OCR_BENCH_PHOTOS_DIR=/ruta/a/fotos)
bash scripts/bench-ocr.sh        # salida en ./bench-results/<timestamp>/
```

Reinicia el worker (para medir "modelos recién cargados"), espera a que esté
healthy y corre el contenedor `ocr-bench` (comparte el espacio de PIDs del
worker para medir su RSS real). Deja `summary.json`, `per_photo.csv` y
`per_photo.json`. Para comparar dos corridas (ej. Windows/x86 contra ARM):

```bash
python ocr-python/bench/compare_runs.py bench-results/<a> bench-results/<b>
```

### Variables

Todas están documentadas en `.env.example`. Las que el compose de producción
**exige** (se niega a levantar sin ellas): `POSTGRES_PASSWORD`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `FRONTEND_URL` y las 5 `STORAGE_*`.
Con default: `POSTGRES_USER` / `POSTGRES_DB`, `BACKEND_HOST_PORT` (3100, solo
modo manual con `docker-compose.port.yml`),
`OCR_MODELS_HOST_DIR` (`./ocr-python/models`), `OCR_THREADS` (2),
`OCR_READ_WATCHDOG_SECONDS` (30), `AUTH_RATE_LIMIT_ENABLED` (true en
producción), `AUTH_IP_ADDRESS_HEADERS` (`x-forwarded-for`; headers, en orden,
de donde Better Auth saca la IP del cliente para el rate limit; si algún día se
activa el proxy de Cloudflare se antepone `cf-connecting-ip`, y solo si el
origen acepta tráfico únicamente de Cloudflare), SMTP (opcional) y `SHIFT_REPORT_EXTRA_RECIPIENTS`. El compose fija
por su cuenta `NODE_ENV=production`, `DATABASE_URL` y `OCR_WORKER_URL`.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

**`NODE_ENV=production` es OBLIGATORIO en el VPS.** Con ese valor,
`src/common/config/env.ts` exige las variables `STORAGE_*` reales (bucket
Cloudflare R2, credenciales propias) en vez de caer silenciosamente a los
defaults del MinIO local — sin `NODE_ENV=production`, el backend arrancaría
igual pero usando credenciales de desarrollo contra storage real
(`StorageService.onModuleInit` loguea un `warn` si detecta este caso). Ver
`.env.example` para el resto de las variables de producción.

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
