# Imagen del backend (NestJS + Prisma 6). Multi-arch: se construye en la
# plataforma donde corre (linux/arm64 en el VPS Hetzner CAX, linux/amd64 en un
# PC), sin cross-compile.
#
# Targets:
#   runtime  imagen final de produccion (default si no se pasa --target).
#   migrate  imagen con devDependencies (CLI de Prisma, ts-node), prisma/ y
#            scripts/: aplica migraciones (`prisma migrate deploy`) y sirve
#            para scripts de mantenimiento como `npm run user:create-admin`.
#
# Prisma genera el motor de consultas para la plataforma donde se construye.
# Si algun dia la imagen se construye en CI en otra arquitectura que la de
# destino (ej. un runner amd64 para un VPS arm64), agregar a
# `generator client` de prisma/schema.prisma:
#   binaryTargets = ["native", "linux-arm64-openssl-3.0.x"]
# (y `debian-openssl-3.0.x` para amd64). Mientras se construya en el VPS no
# hace falta: "native" es la plataforma correcta.

# openssl: el motor de Prisma lo detecta en runtime; sin el, `prisma generate`
# cae a un motor para openssl 1.1 que no carga en bookworm (openssl 3).
FROM node:22-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Todas las dependencias (incluye devDependencies: nest CLI, typescript, prisma).
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build

# Solo dependencias de produccion. El CLI `prisma` es devDependency y no viene
# aca, asi que el cliente generado (node_modules/.prisma) se copia del build.
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

FROM build AS migrate
ENV NODE_ENV=production
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
