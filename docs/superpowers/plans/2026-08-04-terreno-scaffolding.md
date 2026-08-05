# Operación en Terreno — Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar el bloque "Operación en Terreno" (Combustible, Horómetro, Trabajos Extraordinarios, Hallazgos) corriendo end-to-end en `smi-backend` y `smi-frontend`, con una base mínima provisional, siguiendo el patrón §3.1 de la guía.

**Architecture:** Backend NestJS 11 + Prisma sobre SQLite; 1 módulo Nest por subdominio bajo `modules/terreno/`, respuestas `{ data, message }`, DTOs con class-validator, roles vía `@Roles` + guard stub (header `x-dev-role`). Frontend React 19 + Vite 8 + Tailwind v4 + HeroUI v3, con TanStack Query (server state), Zustand (rol de dev), RHF+Zod (forms), axios (HTTP). Base compartida provisional marcada `PROVISIONAL` para reemplazar cuando aterrice el Sprint 0 real.

**Tech Stack:** NestJS 11, Prisma 6, SQLite, TypeScript; React 19, Vite 8, Tailwind v4, HeroUI v3, @tanstack/react-query, zustand, react-hook-form, zod, @hookform/resolvers, axios, react-router v7. Tests: Jest (backend, ya configurado) + Vitest (frontend, se agrega).

## Global Constraints

- **Repos / dirs:** backend en `c:\Users\123\Desktop\ISM\smi-backend`, frontend en `c:\Users\123\Desktop\ISM\smi-frontend`. Rama en ambos: `feat/terreno/scaffolding`.
- **Sin push.** Todo local. Conventional Commits (`feat(terreno): ...`, `chore(api): ...`, `test(terreno): ...`).
- **BD:** SQLite. `DATABASE_URL="file:./dev.db"`. Sin enums Prisma → strings validados.
- **Uniones de literales (exactas):** `criticidad ∈ {BAJA, MEDIA, ALTA, CRITICA}`; `estado hallazgo ∈ {ABIERTO, EN_PROCESO, CERRADO}` (default `ABIERTO`); `turno ∈ {MANANA, TARDE, NOCHE}`; `estado equipo ∈ {OPERATIVO, DETENIDO, MANTENIMIENTO}`.
- **API:** prefijo global `/api`. Rutas: `/api/combustible`, `/api/horometro`, `/api/trabajos-extra`, `/api/hallazgos`, `/api/equipos` (provisional). Respuesta OK: `{ data, message: 'OK' }`. Error: `{ data: null, message }`.
- **CORS:** `origin: http://localhost:5173`, `credentials: true`.
- **Front API base:** `http://localhost:3000/api`, `withCredentials: true`, header `x-dev-role` desde el store.
- **Código provisional** siempre comentado con `// PROVISIONAL — reemplazar con Sprint 0`.
- **Puertos:** backend `3000`, frontend `5173`.

---

## FASE A — BACKEND (smi-backend)

> Rama ya creada: `feat/terreno/scaffolding`. El spec vive en `docs/superpowers/specs/2026-08-04-terreno-scaffolding-design.md`.

### Task A1: Prisma + SQLite + schema + PrismaService

**Files:**
- Modify: `package.json` (deps + bloque `prisma.seed`)
- Create: `prisma/schema.prisma`, `.env`, `.env.example`
- Create: `src/prisma/prisma.service.ts`, `src/prisma/prisma.module.ts`

**Interfaces:**
- Produces: `PrismaService` (extiende `PrismaClient`), `PrismaModule` (global, exporta `PrismaService`). Modelos Prisma: `Equipo`, `RegistroCombustible`, `RegistroHorometro`, `TrabajoExtraordinario`, `Hallazgo`.

- [ ] **Step 1: Instalar Prisma**

Run: `npm install @prisma/client && npm install -D prisma`

- [ ] **Step 2: Crear `.env` y `.env.example`**

Ambos archivos con el mismo contenido (el `.env` real puede diverger luego):

```
DATABASE_URL="file:./dev.db"
PORT=3000
```

- [ ] **Step 3: Crear `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

// PROVISIONAL — dueño real: Amin (Flota). Placeholder mínimo para resolver relaciones.
model Equipo {
  id                String   @id @default(cuid())
  codigo            String   @unique
  tipo              String
  marca             String
  modelo            String
  estado            String   @default("OPERATIVO") // OPERATIVO | DETENIDO | MANTENIMIENTO
  horometroActual   Float    @default(0)
  kilometrajeActual Float    @default(0)

  combustibles  RegistroCombustible[]
  horometros    RegistroHorometro[]
  trabajosExtra TrabajoExtraordinario[]
  hallazgos     Hallazgo[]
}

model RegistroCombustible {
  id          String   @id @default(cuid())
  equipoId    String
  equipo      Equipo   @relation(fields: [equipoId], references: [id])
  litros      Float
  fotoUrl     String?
  rendimiento Float?
  fecha       DateTime @default(now())
}

model RegistroHorometro {
  id           String   @id @default(cuid())
  equipoId     String
  equipo       Equipo   @relation(fields: [equipoId], references: [id])
  operadorId   String   // referencia futura a user.id de Better Auth
  turno        String   // MANANA | TARDE | NOCHE
  valorInicial Float
  valorFinal   Float?
  fecha        DateTime @default(now())
}

model TrabajoExtraordinario {
  id           String   @id @default(cuid())
  equipoId     String
  equipo       Equipo   @relation(fields: [equipoId], references: [id])
  cliente      String
  horasMaquina Float
  tonelaje     Float?
  tarifa       Float
  monto        Float
  fotoUrl      String?
  fecha        DateTime @default(now())
}

model Hallazgo {
  id          String   @id @default(cuid())
  equipoId    String
  equipo      Equipo   @relation(fields: [equipoId], references: [id])
  descripcion String
  criticidad  String   // BAJA | MEDIA | ALTA | CRITICA
  estado      String   @default("ABIERTO") // ABIERTO | EN_PROCESO | CERRADO
  fotoUrl     String?
  fecha       DateTime @default(now())
}
```

- [ ] **Step 4: Crear la primera migración**

Run: `npx prisma migrate dev --name init_terreno`
Expected: crea `prisma/migrations/*/migration.sql`, genera el client, crea `dev.db`.

- [ ] **Step 5: Crear `src/prisma/prisma.service.ts`**

```ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit() {
    await this.$connect();
  }
}
```

- [ ] **Step 6: Crear `src/prisma/prisma.module.ts`**

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

- [ ] **Step 7: Verificar que compila**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 8: Commit**

```bash
git add prisma src/prisma package.json package-lock.json .env.example
git commit -m "feat(terreno): configurar prisma + sqlite y modelos de dominio"
```

> Nota: `.env` está en `.gitignore` (no se commitea); sí se commitea `.env.example`.

---

### Task A2: Capa común (roles, guard stub, filtro, interceptor) + tests

**Files:**
- Create: `src/common/decorators/roles.decorator.ts`
- Create: `src/common/guards/roles.guard.ts` (+ `src/common/guards/roles.guard.spec.ts`)
- Create: `src/common/filters/http-exception.filter.ts`
- Create: `src/common/interceptors/transform.interceptor.ts`
- Create: `src/common/common.module.ts`

**Interfaces:**
- Produces: `@Roles(...roles: Rol[])`, `ROLES_KEY`, type `Rol = 'ADMIN'|'SUPERVISOR'|'MANTENEDOR'|'OPERADOR'`; `RolesGuard`; `HttpExceptionFilter`; `TransformInterceptor` (envuelve en `{ data, message }`); `CommonModule` (registra los tres como APP_GUARD/APP_FILTER/APP_INTERCEPTOR).

- [ ] **Step 1: Crear el decorator de roles**

`src/common/decorators/roles.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';

export type Rol = 'ADMIN' | 'SUPERVISOR' | 'MANTENEDOR' | 'OPERADOR';
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Rol[]) => SetMetadata(ROLES_KEY, roles);
```

- [ ] **Step 2: Escribir el test del guard (falla primero)**

`src/common/guards/roles.guard.spec.ts`:

```ts
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function ctx(role: string | undefined, required: string[] | undefined): ExecutionContext {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  const guard = new RolesGuard(reflector);
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ headers: role ? { 'x-dev-role': role } : {} }) }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext;
  return { guard, context } as any;
}

describe('RolesGuard', () => {
  it('permite cuando no hay roles requeridos', () => {
    const { guard, context } = ctx(undefined, undefined) as any;
    expect(guard.canActivate(context)).toBe(true);
  });

  it('permite cuando el rol coincide', () => {
    const { guard, context } = ctx('supervisor', ['SUPERVISOR', 'ADMIN']) as any;
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rechaza cuando el rol no coincide', () => {
    const { guard, context } = ctx('operador', ['ADMIN']) as any;
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `npm test -- roles.guard`
Expected: FAIL ("Cannot find module './roles.guard'").

- [ ] **Step 4: Implementar el guard stub**

`src/common/guards/roles.guard.ts`:

```ts
// PROVISIONAL — reemplazar por el guard de sesión de Better Auth (Sprint 0).
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, Rol } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Rol[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const rol = (req.headers['x-dev-role'] as string | undefined)?.toUpperCase();
    if (rol && required.includes(rol as Rol)) return true;
    throw new ForbiddenException(`Rol requerido: ${required.join(', ')}`);
  }
}
```

- [ ] **Step 5: Correr el test para verificar que pasa**

Run: `npm test -- roles.guard`
Expected: PASS (3 tests).

- [ ] **Step 6: Crear el filtro de excepciones**

`src/common/filters/http-exception.filter.ts`:

```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload =
      exception instanceof HttpException ? exception.getResponse() : 'Error interno del servidor';
    const raw = typeof payload === 'string' ? payload : (payload as { message: string | string[] }).message;
    const message = Array.isArray(raw) ? raw.join(', ') : raw;
    res.status(status).json({ data: null, message });
  }
}
```

- [ ] **Step 7: Crear el interceptor de respuesta**

`src/common/interceptors/transform.interceptor.ts`:

```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Respuesta<T> {
  data: T;
  message: string;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, Respuesta<T>> {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<Respuesta<T>> {
    return next.handle().pipe(map((data) => ({ data: data ?? null, message: 'OK' }) as Respuesta<T>));
  }
}
```

- [ ] **Step 8: Crear el CommonModule que registra los globales**

`src/common/common.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { RolesGuard } from './guards/roles.guard';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { TransformInterceptor } from './interceptors/transform.interceptor';

@Module({
  providers: [
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class CommonModule {}
```

- [ ] **Step 9: Commit**

```bash
git add src/common
git commit -m "feat(api): capa común con roles stub, filtro y transform interceptor"
```

---

### Task A3: Bootstrap (main.ts + AppModule) + endpoint provisional de equipos

**Files:**
- Modify: `src/main.ts`
- Modify: `src/app.module.ts`
- Delete: `src/app.controller.ts`, `src/app.service.ts`, `src/app.controller.spec.ts`
- Create: `src/modules/equipos/equipos.controller.ts`, `src/modules/equipos/equipos.module.ts`

**Interfaces:**
- Consumes: `PrismaModule`, `CommonModule` (Tasks A1, A2), `PrismaService`.
- Produces: app boot con prefijo `/api`, CORS, ValidationPipe; `EquiposModule` con `GET /api/equipos` y `GET /api/equipos/:id`.

- [ ] **Step 1: Borrar el scaffolding default de Nest**

Run: `rm src/app.controller.ts src/app.service.ts src/app.controller.spec.ts`

- [ ] **Step 2: Crear el controller provisional de equipos**

`src/modules/equipos/equipos.controller.ts`:

```ts
// PROVISIONAL — dueño real: Amin (Flota). Solo lectura para poblar selects del front.
import { Controller, Get, Param } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('equipos')
export class EquiposController {
  constructor(private prisma: PrismaService) {}

  @Get()
  findAll() {
    return this.prisma.equipo.findMany({ orderBy: { codigo: 'asc' } });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.prisma.equipo.findUnique({ where: { id } });
  }
}
```

- [ ] **Step 3: Crear el módulo de equipos**

`src/modules/equipos/equipos.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { EquiposController } from './equipos.controller';

@Module({ controllers: [EquiposController] })
export class EquiposModule {}
```

- [ ] **Step 4: Reescribir `src/app.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { EquiposModule } from './modules/equipos/equipos.module';

@Module({
  imports: [PrismaModule, CommonModule, EquiposModule],
})
export class AppModule {}
```

- [ ] **Step 5: Reescribir `src/main.ts`**

```ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: 'http://localhost:5173', credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
```

- [ ] **Step 6: Levantar y verificar el endpoint de equipos**

Run (terminal 1): `npm run start:dev`
Run (terminal 2): `curl http://localhost:3000/api/equipos`
Expected: `{"data":[],"message":"OK"}` (vacío hasta el seed). Sin errores en consola. Parar el server.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts src/app.module.ts src/modules/equipos
git commit -m "feat(api): bootstrap con prefijo /api, CORS y endpoint provisional de equipos"
```

---

### Task A4: Módulo Combustible (+ test de rendimiento)

**Files:**
- Create: `src/modules/terreno/combustible/dto/create-combustible.dto.ts`, `.../dto/update-combustible.dto.ts`
- Create: `.../combustible.service.ts` (+ `.../combustible.service.spec.ts`), `.../combustible.controller.ts`, `.../combustible.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `@Roles`.
- Produces: `CombustibleModule`; endpoints `GET/POST/PATCH /api/combustible`. `CombustibleService.create` calcula `rendimiento = (lecturaActual - equipo.horometroActual) / litros` (redondeado a 2 decimales) si `lecturaActual` viene y el delta es > 0; si no, `null`.

- [ ] **Step 1: Crear los DTOs**

`.../dto/create-combustible.dto.ts`:

```ts
import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class CreateCombustibleDto {
  @IsString()
  equipoId: string;

  @IsNumber()
  @IsPositive()
  litros: number;

  @IsOptional()
  @IsString()
  fotoUrl?: string;

  @IsOptional()
  @IsNumber()
  lecturaActual?: number;
}
```

`.../dto/update-combustible.dto.ts`:

```ts
import { IsOptional, IsString } from 'class-validator';

export class UpdateCombustibleDto {
  @IsOptional()
  @IsString()
  fotoUrl?: string;
}
```

- [ ] **Step 2: Escribir el test del service (falla primero)**

`.../combustible.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { CombustibleService } from './combustible.service';
import { PrismaService } from '../../../prisma/prisma.service';

describe('CombustibleService', () => {
  let service: CombustibleService;
  const prisma = {
    equipo: { findUnique: jest.fn() },
    registroCombustible: { create: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [CombustibleService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(CombustibleService);
    jest.clearAllMocks();
    prisma.registroCombustible.create.mockImplementation(({ data }: any) => data);
  });

  it('calcula rendimiento = delta / litros', async () => {
    prisma.equipo.findUnique.mockResolvedValue({ id: 'e1', horometroActual: 100 });
    const res = await service.create({ equipoId: 'e1', litros: 10, lecturaActual: 150 } as any);
    expect(res.rendimiento).toBe(5);
  });

  it('deja rendimiento null si no hay lecturaActual', async () => {
    prisma.equipo.findUnique.mockResolvedValue({ id: 'e1', horometroActual: 100 });
    const res = await service.create({ equipoId: 'e1', litros: 10 } as any);
    expect(res.rendimiento).toBeNull();
  });
});
```

- [ ] **Step 3: Correr el test (falla)**

Run: `npm test -- combustible.service`
Expected: FAIL ("Cannot find module './combustible.service'").

- [ ] **Step 4: Implementar el service**

`.../combustible.service.ts`:

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateCombustibleDto } from './dto/create-combustible.dto';
import { UpdateCombustibleDto } from './dto/update-combustible.dto';

@Injectable()
export class CombustibleService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateCombustibleDto) {
    const equipo = await this.prisma.equipo.findUnique({ where: { id: dto.equipoId } });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    let rendimiento: number | null = null;
    if (dto.lecturaActual != null && dto.litros > 0) {
      const delta = dto.lecturaActual - equipo.horometroActual;
      rendimiento = delta > 0 ? Number((delta / dto.litros).toFixed(2)) : null;
    }

    return this.prisma.registroCombustible.create({
      data: { equipoId: dto.equipoId, litros: dto.litros, fotoUrl: dto.fotoUrl ?? null, rendimiento },
    });
  }

  findAll() {
    return this.prisma.registroCombustible.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { codigo: true } } },
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.registroCombustible.findUnique({ where: { id } });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }

  update(id: string, dto: UpdateCombustibleDto) {
    return this.prisma.registroCombustible.update({ where: { id }, data: dto });
  }
}
```

- [ ] **Step 5: Correr el test (pasa)**

Run: `npm test -- combustible.service`
Expected: PASS (2 tests).

- [ ] **Step 6: Crear el controller**

`.../combustible.controller.ts`:

```ts
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CombustibleService } from './combustible.service';
import { CreateCombustibleDto } from './dto/create-combustible.dto';
import { UpdateCombustibleDto } from './dto/update-combustible.dto';
import { Roles } from '../../../common/decorators/roles.decorator';

@Controller('combustible')
export class CombustibleController {
  constructor(private readonly service: CombustibleService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles('SUPERVISOR', 'ADMIN')
  create(@Body() dto: CreateCombustibleDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('SUPERVISOR', 'ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateCombustibleDto) {
    return this.service.update(id, dto);
  }
}
```

- [ ] **Step 7: Crear el módulo**

`.../combustible.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { CombustibleController } from './combustible.controller';
import { CombustibleService } from './combustible.service';

@Module({ controllers: [CombustibleController], providers: [CombustibleService] })
export class CombustibleModule {}
```

- [ ] **Step 8: Commit**

```bash
git add src/modules/terreno/combustible
git commit -m "feat(terreno): módulo combustible con cálculo de rendimiento"
```

---

### Task A5: Módulo Horómetro (+ test cierre actualiza equipo)

**Files:**
- Create: `src/modules/terreno/horometro/dto/create-horometro.dto.ts`, `.../dto/update-horometro.dto.ts`
- Create: `.../horometro.service.ts` (+ `.../horometro.service.spec.ts`), `.../horometro.controller.ts`, `.../horometro.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `@Roles`.
- Produces: `HorometroModule`; endpoints `GET/POST/PATCH /api/horometro`. `HorometroService.create`: al recibir `valorFinal != null` actualiza `Equipo.horometroActual = valorFinal` y deja el gancho del motor preventivo.

- [ ] **Step 1: Crear los DTOs**

`.../dto/create-horometro.dto.ts`:

```ts
import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateHorometroDto {
  @IsString()
  equipoId: string;

  @IsString()
  operadorId: string;

  @IsIn(['MANANA', 'TARDE', 'NOCHE'])
  turno: string;

  @IsNumber()
  valorInicial: number;

  @IsOptional()
  @IsNumber()
  valorFinal?: number;
}
```

`.../dto/update-horometro.dto.ts`:

```ts
import { IsNumber, IsOptional } from 'class-validator';

export class UpdateHorometroDto {
  @IsOptional()
  @IsNumber()
  valorFinal?: number;
}
```

- [ ] **Step 2: Escribir el test del service (falla primero)**

`.../horometro.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { HorometroService } from './horometro.service';
import { PrismaService } from '../../../prisma/prisma.service';

describe('HorometroService', () => {
  let service: HorometroService;
  const prisma = {
    equipo: { findUnique: jest.fn(), update: jest.fn() },
    registroHorometro: { create: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [HorometroService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(HorometroService);
    jest.clearAllMocks();
    prisma.equipo.findUnique.mockResolvedValue({ id: 'e1', horometroActual: 100 });
    prisma.registroHorometro.create.mockImplementation(({ data }: any) => ({ id: 'r1', ...data }));
  });

  it('al cerrar turno actualiza horometroActual del equipo', async () => {
    await service.create({ equipoId: 'e1', operadorId: 'op1', turno: 'MANANA', valorInicial: 100, valorFinal: 130 } as any);
    expect(prisma.equipo.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { horometroActual: 130 } });
  });

  it('sin valorFinal no toca el equipo', async () => {
    await service.create({ equipoId: 'e1', operadorId: 'op1', turno: 'MANANA', valorInicial: 100 } as any);
    expect(prisma.equipo.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Correr el test (falla)**

Run: `npm test -- horometro.service`
Expected: FAIL ("Cannot find module './horometro.service'").

- [ ] **Step 4: Implementar el service**

`.../horometro.service.ts`:

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { UpdateHorometroDto } from './dto/update-horometro.dto';

@Injectable()
export class HorometroService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateHorometroDto) {
    const equipo = await this.prisma.equipo.findUnique({ where: { id: dto.equipoId } });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    const registro = await this.prisma.registroHorometro.create({
      data: {
        equipoId: dto.equipoId,
        operadorId: dto.operadorId,
        turno: dto.turno,
        valorInicial: dto.valorInicial,
        valorFinal: dto.valorFinal ?? null,
      },
    });

    if (dto.valorFinal != null) {
      await this.prisma.equipo.update({
        where: { id: dto.equipoId },
        data: { horometroActual: dto.valorFinal },
      });
      // TODO(motor-preventivo): disparar el umbral de Mantenimiento (Joaquín, guía §5)
      // cuando exista el módulo. Aquí se compararía valorFinal contra UmbralMantenimiento.
    }

    return registro;
  }

  findAll() {
    return this.prisma.registroHorometro.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { codigo: true } } },
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.registroHorometro.findUnique({ where: { id } });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }

  async update(id: string, dto: UpdateHorometroDto) {
    const reg = await this.prisma.registroHorometro.update({ where: { id }, data: dto });
    if (dto.valorFinal != null) {
      await this.prisma.equipo.update({
        where: { id: reg.equipoId },
        data: { horometroActual: dto.valorFinal },
      });
    }
    return reg;
  }
}
```

- [ ] **Step 5: Correr el test (pasa)**

Run: `npm test -- horometro.service`
Expected: PASS (2 tests).

- [ ] **Step 6: Crear el controller**

`.../horometro.controller.ts`:

```ts
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { HorometroService } from './horometro.service';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { UpdateHorometroDto } from './dto/update-horometro.dto';
import { Roles } from '../../../common/decorators/roles.decorator';

@Controller('horometro')
export class HorometroController {
  constructor(private readonly service: HorometroService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles('SUPERVISOR', 'ADMIN')
  create(@Body() dto: CreateHorometroDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('SUPERVISOR', 'ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateHorometroDto) {
    return this.service.update(id, dto);
  }
}
```

- [ ] **Step 7: Crear el módulo**

`.../horometro.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { HorometroController } from './horometro.controller';
import { HorometroService } from './horometro.service';

@Module({ controllers: [HorometroController], providers: [HorometroService] })
export class HorometroModule {}
```

- [ ] **Step 8: Commit**

```bash
git add src/modules/terreno/horometro
git commit -m "feat(terreno): módulo horómetro que cierra turno y actualiza el equipo"
```

---

### Task A6: Módulo Trabajos Extraordinarios (+ test de monto)

**Files:**
- Create: `src/modules/terreno/trabajos-extra/dto/create-trabajo-extra.dto.ts`, `.../dto/update-trabajo-extra.dto.ts`
- Create: `.../trabajos-extra.service.ts` (+ `.spec.ts`), `.../trabajos-extra.controller.ts`, `.../trabajos-extra.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `@Roles`.
- Produces: `TrabajosExtraModule`; endpoints `GET/POST/PATCH /api/trabajos-extra`. `create` calcula `monto = horasMaquina * tarifa` (2 decimales).

- [ ] **Step 1: Crear los DTOs**

`.../dto/create-trabajo-extra.dto.ts`:

```ts
import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class CreateTrabajoExtraDto {
  @IsString()
  equipoId: string;

  @IsString()
  cliente: string;

  @IsNumber()
  @IsPositive()
  horasMaquina: number;

  @IsOptional()
  @IsNumber()
  tonelaje?: number;

  @IsNumber()
  @IsPositive()
  tarifa: number;

  @IsOptional()
  @IsString()
  fotoUrl?: string;
}
```

`.../dto/update-trabajo-extra.dto.ts`:

```ts
import { IsOptional, IsString } from 'class-validator';

export class UpdateTrabajoExtraDto {
  @IsOptional()
  @IsString()
  fotoUrl?: string;
}
```

- [ ] **Step 2: Escribir el test del service (falla primero)**

`.../trabajos-extra.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { TrabajosExtraService } from './trabajos-extra.service';
import { PrismaService } from '../../../prisma/prisma.service';

describe('TrabajosExtraService', () => {
  let service: TrabajosExtraService;
  const prisma = {
    equipo: { findUnique: jest.fn() },
    trabajoExtraordinario: { create: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [TrabajosExtraService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(TrabajosExtraService);
    jest.clearAllMocks();
    prisma.equipo.findUnique.mockResolvedValue({ id: 'e1' });
    prisma.trabajoExtraordinario.create.mockImplementation(({ data }: any) => data);
  });

  it('calcula monto = horasMaquina * tarifa', async () => {
    const res = await service.create({ equipoId: 'e1', cliente: 'X', horasMaquina: 12, tarifa: 85000 } as any);
    expect(res.monto).toBe(1020000);
  });
});
```

- [ ] **Step 3: Correr el test (falla)**

Run: `npm test -- trabajos-extra.service`
Expected: FAIL ("Cannot find module './trabajos-extra.service'").

- [ ] **Step 4: Implementar el service**

`.../trabajos-extra.service.ts`:

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateTrabajoExtraDto } from './dto/create-trabajo-extra.dto';
import { UpdateTrabajoExtraDto } from './dto/update-trabajo-extra.dto';

@Injectable()
export class TrabajosExtraService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateTrabajoExtraDto) {
    const equipo = await this.prisma.equipo.findUnique({ where: { id: dto.equipoId } });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    const monto = Number((dto.horasMaquina * dto.tarifa).toFixed(2));
    return this.prisma.trabajoExtraordinario.create({
      data: {
        equipoId: dto.equipoId,
        cliente: dto.cliente,
        horasMaquina: dto.horasMaquina,
        tonelaje: dto.tonelaje ?? null,
        tarifa: dto.tarifa,
        monto,
        fotoUrl: dto.fotoUrl ?? null,
      },
    });
  }

  findAll() {
    return this.prisma.trabajoExtraordinario.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { codigo: true } } },
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.trabajoExtraordinario.findUnique({ where: { id } });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }

  update(id: string, dto: UpdateTrabajoExtraDto) {
    return this.prisma.trabajoExtraordinario.update({ where: { id }, data: dto });
  }
}
```

- [ ] **Step 5: Correr el test (pasa)**

Run: `npm test -- trabajos-extra.service`
Expected: PASS (1 test).

- [ ] **Step 6: Crear el controller**

`.../trabajos-extra.controller.ts`:

```ts
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { TrabajosExtraService } from './trabajos-extra.service';
import { CreateTrabajoExtraDto } from './dto/create-trabajo-extra.dto';
import { UpdateTrabajoExtraDto } from './dto/update-trabajo-extra.dto';
import { Roles } from '../../../common/decorators/roles.decorator';

@Controller('trabajos-extra')
export class TrabajosExtraController {
  constructor(private readonly service: TrabajosExtraService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles('SUPERVISOR', 'ADMIN')
  create(@Body() dto: CreateTrabajoExtraDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('SUPERVISOR', 'ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateTrabajoExtraDto) {
    return this.service.update(id, dto);
  }
}
```

- [ ] **Step 7: Crear el módulo**

`.../trabajos-extra.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TrabajosExtraController } from './trabajos-extra.controller';
import { TrabajosExtraService } from './trabajos-extra.service';

@Module({ controllers: [TrabajosExtraController], providers: [TrabajosExtraService] })
export class TrabajosExtraModule {}
```

- [ ] **Step 8: Commit**

```bash
git add src/modules/terreno/trabajos-extra
git commit -m "feat(terreno): módulo trabajos extraordinarios con cálculo de monto"
```

---

### Task A7: Módulo Hallazgos (+ test de estado default)

**Files:**
- Create: `src/modules/terreno/hallazgos/dto/create-hallazgo.dto.ts`, `.../dto/update-hallazgo.dto.ts`
- Create: `.../hallazgos.service.ts` (+ `.spec.ts`), `.../hallazgos.controller.ts`, `.../hallazgos.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `@Roles`.
- Produces: `HallazgosModule`; endpoints `GET/POST/PATCH /api/hallazgos`. `create` fuerza `estado='ABIERTO'`. `update` permite cambiar `estado`.

- [ ] **Step 1: Crear los DTOs**

`.../dto/create-hallazgo.dto.ts`:

```ts
import { IsIn, IsOptional, IsString } from 'class-validator';

export class CreateHallazgoDto {
  @IsString()
  equipoId: string;

  @IsString()
  descripcion: string;

  @IsIn(['BAJA', 'MEDIA', 'ALTA', 'CRITICA'])
  criticidad: string;

  @IsOptional()
  @IsString()
  fotoUrl?: string;
}
```

`.../dto/update-hallazgo.dto.ts`:

```ts
import { IsIn, IsOptional } from 'class-validator';

export class UpdateHallazgoDto {
  @IsOptional()
  @IsIn(['ABIERTO', 'EN_PROCESO', 'CERRADO'])
  estado?: string;
}
```

- [ ] **Step 2: Escribir el test del service (falla primero)**

`.../hallazgos.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { HallazgosService } from './hallazgos.service';
import { PrismaService } from '../../../prisma/prisma.service';

describe('HallazgosService', () => {
  let service: HallazgosService;
  const prisma = {
    equipo: { findUnique: jest.fn() },
    hallazgo: { create: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [HallazgosService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(HallazgosService);
    jest.clearAllMocks();
    prisma.equipo.findUnique.mockResolvedValue({ id: 'e1' });
    prisma.hallazgo.create.mockImplementation(({ data }: any) => data);
  });

  it('crea con estado ABIERTO por defecto', async () => {
    const res = await service.create({ equipoId: 'e1', descripcion: 'Fuga', criticidad: 'ALTA' } as any);
    expect(res.estado).toBe('ABIERTO');
  });
});
```

- [ ] **Step 3: Correr el test (falla)**

Run: `npm test -- hallazgos.service`
Expected: FAIL ("Cannot find module './hallazgos.service'").

- [ ] **Step 4: Implementar el service**

`.../hallazgos.service.ts`:

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateHallazgoDto } from './dto/create-hallazgo.dto';
import { UpdateHallazgoDto } from './dto/update-hallazgo.dto';

@Injectable()
export class HallazgosService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateHallazgoDto) {
    const equipo = await this.prisma.equipo.findUnique({ where: { id: dto.equipoId } });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    return this.prisma.hallazgo.create({
      data: {
        equipoId: dto.equipoId,
        descripcion: dto.descripcion,
        criticidad: dto.criticidad,
        estado: 'ABIERTO',
        fotoUrl: dto.fotoUrl ?? null,
      },
    });
  }

  findAll() {
    return this.prisma.hallazgo.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { codigo: true } } },
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.hallazgo.findUnique({ where: { id } });
    if (!reg) throw new NotFoundException('Hallazgo no encontrado');
    return reg;
  }

  update(id: string, dto: UpdateHallazgoDto) {
    return this.prisma.hallazgo.update({ where: { id }, data: dto });
  }
}
```

- [ ] **Step 5: Correr el test (pasa)**

Run: `npm test -- hallazgos.service`
Expected: PASS (1 test).

- [ ] **Step 6: Crear el controller**

`.../hallazgos.controller.ts`:

```ts
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { HallazgosService } from './hallazgos.service';
import { CreateHallazgoDto } from './dto/create-hallazgo.dto';
import { UpdateHallazgoDto } from './dto/update-hallazgo.dto';
import { Roles } from '../../../common/decorators/roles.decorator';

@Controller('hallazgos')
export class HallazgosController {
  constructor(private readonly service: HallazgosService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles('SUPERVISOR', 'ADMIN')
  create(@Body() dto: CreateHallazgoDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('SUPERVISOR', 'ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateHallazgoDto) {
    return this.service.update(id, dto);
  }
}
```

- [ ] **Step 7: Crear el módulo**

`.../hallazgos.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { HallazgosController } from './hallazgos.controller';
import { HallazgosService } from './hallazgos.service';

@Module({ controllers: [HallazgosController], providers: [HallazgosService] })
export class HallazgosModule {}
```

- [ ] **Step 8: Commit**

```bash
git add src/modules/terreno/hallazgos
git commit -m "feat(terreno): módulo hallazgos con estado ABIERTO por defecto"
```

---

### Task A8: Agregar TerrenoModule y registrarlo en AppModule

**Files:**
- Create: `src/modules/terreno/terreno.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `CombustibleModule`, `HorometroModule`, `TrabajosExtraModule`, `HallazgosModule` (Tasks A4–A7).
- Produces: `TerrenoModule` importado por `AppModule` → las 4 rutas quedan activas.

- [ ] **Step 1: Crear `terreno.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { CombustibleModule } from './combustible/combustible.module';
import { HorometroModule } from './horometro/horometro.module';
import { TrabajosExtraModule } from './trabajos-extra/trabajos-extra.module';
import { HallazgosModule } from './hallazgos/hallazgos.module';

@Module({
  imports: [CombustibleModule, HorometroModule, TrabajosExtraModule, HallazgosModule],
})
export class TerrenoModule {}
```

- [ ] **Step 2: Agregar `TerrenoModule` a `AppModule`**

Modificar `src/app.module.ts` para que quede:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { EquiposModule } from './modules/equipos/equipos.module';
import { TerrenoModule } from './modules/terreno/terreno.module';

@Module({
  imports: [PrismaModule, CommonModule, EquiposModule, TerrenoModule],
})
export class AppModule {}
```

- [ ] **Step 3: Correr toda la suite de tests**

Run: `npm test`
Expected: PASS (guard 3 + combustible 2 + horómetro 2 + trabajos 1 + hallazgos 1 = 9 tests).

- [ ] **Step 4: Levantar y verificar las 4 rutas**

Run (terminal 1): `npm run start:dev`
Run (terminal 2):
```bash
curl http://localhost:3000/api/combustible
curl http://localhost:3000/api/horometro
curl http://localhost:3000/api/trabajos-extra
curl http://localhost:3000/api/hallazgos
```
Expected: cada uno `{"data":[],"message":"OK"}`. Parar el server.

- [ ] **Step 5: Commit**

```bash
git add src/modules/terreno/terreno.module.ts src/app.module.ts
git commit -m "feat(terreno): agrupar submódulos en TerrenoModule y registrarlo"
```

---

### Task A9: Seed de datos de ejemplo

**Files:**
- Create: `prisma/seed.ts`
- Modify: `package.json` (bloque `"prisma": { "seed": ... }`)

**Interfaces:**
- Consumes: modelos Prisma (Task A1).
- Produces: 6 equipos + registros de terreno en `dev.db`.

- [ ] **Step 1: Agregar el bloque de seed a `package.json`**

Agregar al nivel raíz del JSON (junto a `"scripts"`):

```json
"prisma": {
  "seed": "ts-node prisma/seed.ts"
}
```

- [ ] **Step 2: Crear `prisma/seed.ts`**

```ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // PROVISIONAL — los equipos normalmente los siembra Amin (Flota).
  const equiposData = [
    { codigo: 'EX-001', tipo: 'Excavadora', marca: 'Caterpillar', modelo: '336', estado: 'OPERATIVO', horometroActual: 1200, kilometrajeActual: 0 },
    { codigo: 'CG-002', tipo: 'Cargador', marca: 'Komatsu', modelo: 'WA320', estado: 'OPERATIVO', horometroActual: 800, kilometrajeActual: 0 },
    { codigo: 'CM-003', tipo: 'Camión', marca: 'Volvo', modelo: 'FMX', estado: 'MANTENIMIENTO', horometroActual: 5400, kilometrajeActual: 82000 },
    { codigo: 'PE-004', tipo: 'Perforadora', marca: 'Sandvik', modelo: 'DP1500', estado: 'DETENIDO', horometroActual: 300, kilometrajeActual: 0 },
    { codigo: 'BD-005', tipo: 'Bulldozer', marca: 'Caterpillar', modelo: 'D6', estado: 'OPERATIVO', horometroActual: 2100, kilometrajeActual: 0 },
    { codigo: 'CM-006', tipo: 'Camión', marca: 'Scania', modelo: 'R450', estado: 'OPERATIVO', horometroActual: 3300, kilometrajeActual: 51000 },
  ];

  await prisma.registroCombustible.deleteMany();
  await prisma.registroHorometro.deleteMany();
  await prisma.trabajoExtraordinario.deleteMany();
  await prisma.hallazgo.deleteMany();
  await prisma.equipo.deleteMany();

  const equipos = [];
  for (const e of equiposData) equipos.push(await prisma.equipo.create({ data: e }));

  await prisma.registroCombustible.createMany({
    data: [
      { equipoId: equipos[0].id, litros: 120, rendimiento: 4.5 },
      { equipoId: equipos[1].id, litros: 90, rendimiento: 5.1 },
      { equipoId: equipos[5].id, litros: 200, rendimiento: 3.8 },
    ],
  });

  await prisma.registroHorometro.createMany({
    data: [
      { equipoId: equipos[0].id, operadorId: 'user-operador-1', turno: 'MANANA', valorInicial: 1180, valorFinal: 1200 },
      { equipoId: equipos[1].id, operadorId: 'user-operador-2', turno: 'TARDE', valorInicial: 790, valorFinal: 800 },
    ],
  });

  await prisma.trabajoExtraordinario.createMany({
    data: [
      { equipoId: equipos[2].id, cliente: 'Minera Norte', horasMaquina: 12, tonelaje: 340, tarifa: 85000, monto: 1020000 },
      { equipoId: equipos[5].id, cliente: 'Áridos Sur', horasMaquina: 8, tonelaje: 210, tarifa: 70000, monto: 560000 },
    ],
  });

  await prisma.hallazgo.createMany({
    data: [
      { equipoId: equipos[3].id, descripcion: 'Fuga de aceite hidráulico', criticidad: 'ALTA', estado: 'ABIERTO' },
      { equipoId: equipos[0].id, descripcion: 'Ruido anormal en el motor', criticidad: 'MEDIA', estado: 'EN_PROCESO' },
      { equipoId: equipos[2].id, descripcion: 'Frenos con baja respuesta', criticidad: 'CRITICA', estado: 'ABIERTO' },
    ],
  });

  console.log('Seed completado.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
```

- [ ] **Step 3: Correr el seed**

Run: `npx prisma db seed`
Expected: "Seed completado." sin errores.

- [ ] **Step 4: Verificar datos vía API**

Run (terminal 1): `npm run start:dev`
Run (terminal 2): `curl http://localhost:3000/api/equipos` y `curl http://localhost:3000/api/hallazgos`
Expected: `data` con 6 equipos y 3 hallazgos respectivamente. Parar el server.

- [ ] **Step 5: Commit**

```bash
git add prisma/seed.ts package.json
git commit -m "feat(terreno): seed con equipos y registros de terreno"
```

**FIN FASE A.** El backend corre en `http://localhost:3000/api` con datos reales.

---

## FASE B — FRONTEND (smi-frontend)

> Cambiar de repo: `cd c:\Users\123\Desktop\ISM\smi-frontend`. Crear rama: `git checkout -b feat/terreno/scaffolding`.

**Decisión de UI (aplica a todas las páginas):** HeroUI v3 se usa para `Button` e `Input` (APIs estables y con `label`/`errorMessage` propios). Selects, tablas y badges de estado se renderizan con HTML semántico + los tokens de tema ya existentes en `src/index.css` (`bg-card`, `border-border`, `text-muted-foreground`, `bg-primary`, `text-primary-foreground`, `bg-destructive`, `rounded-(--radius)`, etc.). Motivo: los componentes compound de HeroUI v3 (`Table`, `Select`) son nuevos y de API cambiante; esta mezcla es 100% confiable y se ve cohesiva. **Fallback:** si `Input`/`Button` de HeroUI diera fricción con RHF `register`, reemplazar por `<input>`/`<button>` themed (mismo markup, sin cambiar la lógica).

### Task B1: Instalar dependencias + estilos HeroUI + Vitest + env

**Files:**
- Modify: `package.json` (deps + script `test`)
- Modify: `src/index.css` (import de `@heroui/styles`)
- Create: `vitest.config.ts`, `.env`, `.env.example`

**Interfaces:**
- Produces: dependencias instaladas; `@import "@heroui/styles"` activo; `npm test` corre Vitest; `import.meta.env.VITE_API_URL` disponible.

- [ ] **Step 1: Instalar dependencias de runtime**

Run:
```bash
npm install @heroui/react @heroui/styles @tanstack/react-query zustand react-hook-form zod @hookform/resolvers axios react-router
```

- [ ] **Step 2: Instalar Vitest**

Run: `npm install -D vitest`

- [ ] **Step 3: Agregar el script de test a `package.json`**

En `"scripts"`, agregar: `"test": "vitest run"`.

- [ ] **Step 4: Importar los estilos de HeroUI**

En `src/index.css`, la línea 2 debe quedar el import de HeroUI, **inmediatamente después** del import de tailwind. Editar el inicio del archivo para que sea:

```css
@import "tailwindcss";
@import "@heroui/styles";
@custom-variant dark (&:where(.dark, .dark *));
```

(El resto del archivo —variables `:root`, `.dark`, `@theme inline`, `@layer base`— se deja igual.)

- [ ] **Step 5: Crear `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 6: Crear `.env` y `.env.example`**

Ambos con:

```
VITE_API_URL=http://localhost:3000/api
```

- [ ] **Step 7: Verificar que el dev server sigue levantando**

Run: `npm run dev`
Expected: Vite arranca sin errores en `http://localhost:5173`; la página placeholder "SMI" se ve con estilos. Parar el server.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/index.css vitest.config.ts .env.example
git commit -m "chore(web): instalar stack (heroui, tanstack, zustand, rhf, zod, axios, router) + vitest"
```

---

### Task B2: Base compartida (api client, types, store, queryClient, equipos)

**Files:**
- Create: `src/shared/api/types.ts`, `src/shared/api/client.ts`, `src/shared/api/equipos.ts`
- Create: `src/shared/store/auth.store.ts`
- Create: `src/shared/lib/query.ts`
- Create: `src/shared/hooks/useEquipos.ts`

**Interfaces:**
- Produces: `ApiResponse<T>`; `api` (axios); `useAuthStore` (`rol`, `setRol`), type `Rol`; `queryClient`; `Equipo`, `listEquipos`, `useEquipos`.

- [ ] **Step 1: Crear el tipo de respuesta**

`src/shared/api/types.ts`:

```ts
export interface ApiResponse<T> {
  data: T;
  message: string;
}
```

- [ ] **Step 2: Crear el store de auth (rol de dev)**

`src/shared/store/auth.store.ts`:

```ts
import { create } from 'zustand';

export type Rol = 'ADMIN' | 'SUPERVISOR' | 'MANTENEDOR' | 'OPERADOR';

interface AuthState {
  rol: Rol;
  setRol: (rol: Rol) => void;
}

// PROVISIONAL — reemplazar por useSession() de Better Auth (Sprint 0).
export const useAuthStore = create<AuthState>((set) => ({
  rol: 'ADMIN',
  setRol: (rol) => set({ rol }),
}));
```

- [ ] **Step 3: Crear el cliente axios**

`src/shared/api/client.ts`:

```ts
import axios from 'axios';
import { useAuthStore } from '../store/auth.store';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api',
  withCredentials: true,
});

// PROVISIONAL — inyecta el rol de dev para el guard stub del backend.
api.interceptors.request.use((config) => {
  const rol = useAuthStore.getState().rol;
  if (rol) config.headers['x-dev-role'] = rol;
  return config;
});
```

- [ ] **Step 4: Crear el queryClient**

`src/shared/lib/query.ts`:

```ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});
```

- [ ] **Step 5: Crear la api de equipos**

`src/shared/api/equipos.ts`:

```ts
import { api } from './client';
import type { ApiResponse } from './types';

export interface Equipo {
  id: string;
  codigo: string;
  tipo: string;
  marca: string;
  modelo: string;
  estado: string;
  horometroActual: number;
  kilometrajeActual: number;
}

export async function listEquipos(): Promise<Equipo[]> {
  const res = await api.get<ApiResponse<Equipo[]>>('/equipos');
  return res.data.data;
}
```

- [ ] **Step 6: Crear el hook de equipos**

`src/shared/hooks/useEquipos.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { listEquipos } from '../api/equipos';

export function useEquipos() {
  return useQuery({ queryKey: ['equipos'], queryFn: listEquipos });
}
```

- [ ] **Step 7: Verificar compilación de tipos**

Run: `npx tsc -b --noEmit` (o `npm run build` sin emitir; si falla por falta de páginas todavía no creadas, ignorar esos imports — a esta altura `shared/` compila solo).
Expected: `shared/` sin errores de tipo.

- [ ] **Step 8: Commit**

```bash
git add src/shared
git commit -m "feat(web): base compartida (api client, store de rol, queryClient, equipos)"
```

---

### Task B3: Layout, router shell y wiring en main.tsx

**Files:**
- Create: `src/shared/layout/AppLayout.tsx`
- Create: `src/shared/router.tsx`
- Modify: `src/main.tsx`
- Delete: `src/App.tsx` (reemplazado por el layout/router)

**Interfaces:**
- Consumes: `useAuthStore`, `queryClient`.
- Produces: `AppLayout` (sidebar + selector de rol + `<Outlet/>`); `router` (con placeholder index por ahora); app montada con `QueryClientProvider` + `RouterProvider`.

- [ ] **Step 1: Crear el layout**

`src/shared/layout/AppLayout.tsx`:

```tsx
import { NavLink, Outlet } from 'react-router';
import { useAuthStore, type Rol } from '../store/auth.store';

const nav = [
  { to: '/terreno/combustible', label: 'Combustible' },
  { to: '/terreno/horometro', label: 'Horómetro' },
  { to: '/terreno/trabajos-extra', label: 'Trabajos extra' },
  { to: '/terreno/hallazgos', label: 'Hallazgos' },
];

const roles: Rol[] = ['ADMIN', 'SUPERVISOR', 'MANTENEDOR', 'OPERADOR'];

export function AppLayout() {
  const { rol, setRol } = useAuthStore();
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="w-60 shrink-0 border-r border-border bg-sidebar p-4">
        <h2 className="text-lg font-semibold">SMI</h2>
        <p className="mb-4 text-xs text-muted-foreground">Operación en Terreno</p>
        <nav className="flex flex-col gap-1">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-6">
          {/* PROVISIONAL — selector de rol para el guard stub. Reemplazar por Better Auth. */}
          <label className="text-xs text-muted-foreground">Rol (dev)</label>
          <select
            value={rol}
            onChange={(e) => setRol(e.target.value as Rol)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2 text-sm"
          >
            {roles.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
      </aside>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Crear el router shell (placeholder index)**

`src/shared/router.tsx`:

```tsx
import { createBrowserRouter } from 'react-router';
import { AppLayout } from './layout/AppLayout';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      {
        index: true,
        element: <p className="text-muted-foreground">Elegí una sección en el menú.</p>,
      },
    ],
  },
]);
```

- [ ] **Step 3: Reescribir `main.tsx`**

`src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { queryClient } from './shared/lib/query';
import { router } from './shared/router';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 4: Borrar `App.tsx`**

Run: `rm src/App.tsx`

- [ ] **Step 5: Levantar y verificar el layout**

Run: `npm run dev`
Expected: se ve el sidebar "SMI / Operación en Terreno" con los 4 links, el selector de rol, y el mensaje "Elegí una sección". Sin errores en consola. Parar el server.

- [ ] **Step 6: Commit**

```bash
git add src/shared/layout src/shared/router.tsx src/main.tsx
git commit -m "feat(web): layout con sidebar, selector de rol y router"
```

---

### Task B4: Módulo Combustible (schema+test, api, hooks, page)

**Files:**
- Create: `src/modules/terreno/combustible/schema.ts` (+ `schema.test.ts`), `.../api.ts`, `.../hooks.ts`, `.../CombustiblePage.tsx`

**Interfaces:**
- Consumes: `api`, `ApiResponse`, `useEquipos`.
- Produces: `combustibleFormSchema`, `CombustibleForm`, `RegistroCombustible`; `useCombustibleList`, `useCreateCombustible`; `CombustiblePage`.

- [ ] **Step 1: Escribir el test del schema (falla primero)**

`src/modules/terreno/combustible/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { combustibleFormSchema } from './schema';

describe('combustibleFormSchema', () => {
  it('rechaza litros <= 0', () => {
    const r = combustibleFormSchema.safeParse({ equipoId: 'e1', litros: 0 });
    expect(r.success).toBe(false);
  });

  it('acepta un registro válido', () => {
    const r = combustibleFormSchema.safeParse({ equipoId: 'e1', litros: 50 });
    expect(r.success).toBe(true);
  });

  it('rechaza equipoId vacío', () => {
    const r = combustibleFormSchema.safeParse({ equipoId: '', litros: 50 });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npm test -- combustible`
Expected: FAIL ("Cannot find module './schema'").

- [ ] **Step 3: Crear el schema**

`src/modules/terreno/combustible/schema.ts`:

```ts
import { z } from 'zod';

export const combustibleFormSchema = z.object({
  equipoId: z.string().min(1, 'Seleccioná un equipo'),
  litros: z.coerce.number().positive('Litros debe ser mayor a 0'),
  lecturaActual: z.coerce.number().optional(),
  fotoUrl: z.string().url('URL inválida').optional().or(z.literal('')),
});

export type CombustibleForm = z.infer<typeof combustibleFormSchema>;

export interface RegistroCombustible {
  id: string;
  equipoId: string;
  litros: number;
  fotoUrl: string | null;
  rendimiento: number | null;
  fecha: string;
  equipo?: { codigo: string };
}
```

- [ ] **Step 4: Correr el test (pasa)**

Run: `npm test -- combustible`
Expected: PASS (3 tests).

- [ ] **Step 5: Crear la capa api**

`src/modules/terreno/combustible/api.ts`:

```ts
import { api } from '../../../shared/api/client';
import type { ApiResponse } from '../../../shared/api/types';
import type { CombustibleForm, RegistroCombustible } from './schema';

export async function listCombustible(): Promise<RegistroCombustible[]> {
  const res = await api.get<ApiResponse<RegistroCombustible[]>>('/combustible');
  return res.data.data;
}

export async function createCombustible(payload: CombustibleForm): Promise<RegistroCombustible> {
  const body = { ...payload, fotoUrl: payload.fotoUrl || undefined };
  const res = await api.post<ApiResponse<RegistroCombustible>>('/combustible', body);
  return res.data.data;
}
```

- [ ] **Step 6: Crear los hooks**

`src/modules/terreno/combustible/hooks.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listCombustible, createCombustible } from './api';

const KEY = ['combustible'];

export function useCombustibleList() {
  return useQuery({ queryKey: KEY, queryFn: listCombustible });
}

export function useCreateCombustible() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createCombustible,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
```

- [ ] **Step 7: Crear la página**

`src/modules/terreno/combustible/CombustiblePage.tsx`:

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input } from '@heroui/react';
import { combustibleFormSchema, type CombustibleForm } from './schema';
import { useCombustibleList, useCreateCombustible } from './hooks';
import { useEquipos } from '../../../shared/hooks/useEquipos';

export function CombustiblePage() {
  const { data: equipos = [] } = useEquipos();
  const { data: registros = [], isLoading } = useCombustibleList();
  const crear = useCreateCombustible();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CombustibleForm>({
    resolver: zodResolver(combustibleFormSchema),
    defaultValues: { equipoId: '', litros: 0 },
  });

  const onSubmit = (values: CombustibleForm) => {
    crear.mutate(values, { onSuccess: () => reset({ equipoId: '', litros: 0 }) });
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Cargas de combustible</h1>
        <p className="text-sm text-muted-foreground">
          Registrá una carga con foto; el sistema calcula el rendimiento.
        </p>
      </header>

      <form
        onSubmit={handleSubmit(onSubmit)}
        className="grid gap-4 rounded-(--radius) border border-border bg-card p-4 sm:grid-cols-2"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Equipo</span>
          <select {...register('equipoId')} className="rounded-lg border border-border bg-background p-2">
            <option value="">Seleccioná…</option>
            {equipos.map((e) => (
              <option key={e.id} value={e.id}>{e.codigo} — {e.modelo}</option>
            ))}
          </select>
          {errors.equipoId && <span className="text-destructive text-xs">{errors.equipoId.message}</span>}
        </label>

        <Input
          label="Litros"
          type="number"
          step="0.1"
          isInvalid={!!errors.litros}
          errorMessage={errors.litros?.message}
          {...register('litros')}
        />
        <Input label="Lectura actual (horómetro)" type="number" step="0.1" {...register('lecturaActual')} />
        <Input
          label="Foto (URL)"
          isInvalid={!!errors.fotoUrl}
          errorMessage={errors.fotoUrl?.message}
          {...register('fotoUrl')}
        />

        <div className="sm:col-span-2">
          <Button type="submit" color="primary" isLoading={crear.isPending}>
            Registrar carga
          </Button>
        </div>
      </form>

      <section className="overflow-hidden rounded-(--radius) border border-border bg-card">
        {isLoading ? (
          <p className="p-4 text-muted-foreground">Cargando…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b border-border">
                <th className="p-3">Equipo</th>
                <th className="p-3">Litros</th>
                <th className="p-3">Rendimiento</th>
                <th className="p-3">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {registros.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="p-3">{r.equipo?.codigo ?? r.equipoId}</td>
                  <td className="p-3">{r.litros} L</td>
                  <td className="p-3">{r.rendimiento != null ? r.rendimiento : '—'}</td>
                  <td className="p-3">{new Date(r.fecha).toLocaleDateString()}</td>
                </tr>
              ))}
              {registros.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-4 text-muted-foreground">Sin registros.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add src/modules/terreno/combustible
git commit -m "feat(terreno): pantalla de cargas de combustible (patrón §3.1)"
```

---

### Task B5: Módulo Horómetro

**Files:**
- Create: `src/modules/terreno/horometro/schema.ts` (+ `schema.test.ts`), `.../api.ts`, `.../hooks.ts`, `.../HorometroPage.tsx`

**Interfaces:**
- Produces: `horometroFormSchema`, `HorometroForm`, `RegistroHorometro`; `useHorometroList`, `useCreateHorometro`; `HorometroPage`.

- [ ] **Step 1: Escribir el test del schema (falla primero)**

`.../horometro/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { horometroFormSchema } from './schema';

describe('horometroFormSchema', () => {
  it('acepta un registro válido', () => {
    const r = horometroFormSchema.safeParse({
      equipoId: 'e1', operadorId: 'op1', turno: 'MANANA', valorInicial: 100,
    });
    expect(r.success).toBe(true);
  });

  it('rechaza turno inválido', () => {
    const r = horometroFormSchema.safeParse({
      equipoId: 'e1', operadorId: 'op1', turno: 'MADRUGADA', valorInicial: 100,
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npm test -- horometro`
Expected: FAIL ("Cannot find module './schema'").

- [ ] **Step 3: Crear el schema**

`.../horometro/schema.ts`:

```ts
import { z } from 'zod';

export const horometroFormSchema = z.object({
  equipoId: z.string().min(1, 'Seleccioná un equipo'),
  operadorId: z.string().min(1, 'Indicá el operador'),
  turno: z.enum(['MANANA', 'TARDE', 'NOCHE']),
  valorInicial: z.coerce.number().nonnegative('Valor inválido'),
  valorFinal: z.coerce.number().optional(),
});

export type HorometroForm = z.infer<typeof horometroFormSchema>;

export interface RegistroHorometro {
  id: string;
  equipoId: string;
  operadorId: string;
  turno: string;
  valorInicial: number;
  valorFinal: number | null;
  fecha: string;
  equipo?: { codigo: string };
}
```

- [ ] **Step 4: Correr el test (pasa)**

Run: `npm test -- horometro`
Expected: PASS (2 tests).

- [ ] **Step 5: Crear la capa api**

`.../horometro/api.ts`:

```ts
import { api } from '../../../shared/api/client';
import type { ApiResponse } from '../../../shared/api/types';
import type { HorometroForm, RegistroHorometro } from './schema';

export async function listHorometro(): Promise<RegistroHorometro[]> {
  const res = await api.get<ApiResponse<RegistroHorometro[]>>('/horometro');
  return res.data.data;
}

export async function createHorometro(payload: HorometroForm): Promise<RegistroHorometro> {
  const res = await api.post<ApiResponse<RegistroHorometro>>('/horometro', payload);
  return res.data.data;
}
```

- [ ] **Step 6: Crear los hooks**

`.../horometro/hooks.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listHorometro, createHorometro } from './api';

const KEY = ['horometro'];

export function useHorometroList() {
  return useQuery({ queryKey: KEY, queryFn: listHorometro });
}

export function useCreateHorometro() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createHorometro,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['equipos'] });
    },
  });
}
```

- [ ] **Step 7: Crear la página**

`.../horometro/HorometroPage.tsx`:

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input } from '@heroui/react';
import { horometroFormSchema, type HorometroForm } from './schema';
import { useHorometroList, useCreateHorometro } from './hooks';
import { useEquipos } from '../../../shared/hooks/useEquipos';

const TURNOS = ['MANANA', 'TARDE', 'NOCHE'] as const;

export function HorometroPage() {
  const { data: equipos = [] } = useEquipos();
  const { data: registros = [], isLoading } = useHorometroList();
  const crear = useCreateHorometro();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<HorometroForm>({
    resolver: zodResolver(horometroFormSchema),
    defaultValues: { equipoId: '', operadorId: '', turno: 'MANANA', valorInicial: 0 },
  });

  const onSubmit = (values: HorometroForm) =>
    crear.mutate(values, { onSuccess: () => reset({ equipoId: '', operadorId: '', turno: 'MANANA', valorInicial: 0 }) });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Registro de horómetro por turno</h1>
        <p className="text-sm text-muted-foreground">Al cerrar el turno se actualiza el horómetro del equipo.</p>
      </header>

      <form
        onSubmit={handleSubmit(onSubmit)}
        className="grid gap-4 rounded-(--radius) border border-border bg-card p-4 sm:grid-cols-2"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Equipo</span>
          <select {...register('equipoId')} className="rounded-lg border border-border bg-background p-2">
            <option value="">Seleccioná…</option>
            {equipos.map((e) => (
              <option key={e.id} value={e.id}>{e.codigo} — {e.modelo}</option>
            ))}
          </select>
          {errors.equipoId && <span className="text-destructive text-xs">{errors.equipoId.message}</span>}
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Turno</span>
          <select {...register('turno')} className="rounded-lg border border-border bg-background p-2">
            {TURNOS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>

        <Input
          label="Operador (id)"
          isInvalid={!!errors.operadorId}
          errorMessage={errors.operadorId?.message}
          {...register('operadorId')}
        />
        <Input label="Valor inicial" type="number" step="0.1" {...register('valorInicial')} />
        <Input label="Valor final (cierra turno)" type="number" step="0.1" {...register('valorFinal')} />

        <div className="sm:col-span-2">
          <Button type="submit" color="primary" isLoading={crear.isPending}>
            Registrar lectura
          </Button>
        </div>
      </form>

      <section className="overflow-hidden rounded-(--radius) border border-border bg-card">
        {isLoading ? (
          <p className="p-4 text-muted-foreground">Cargando…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b border-border">
                <th className="p-3">Equipo</th>
                <th className="p-3">Turno</th>
                <th className="p-3">Inicial</th>
                <th className="p-3">Final</th>
                <th className="p-3">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {registros.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="p-3">{r.equipo?.codigo ?? r.equipoId}</td>
                  <td className="p-3">{r.turno}</td>
                  <td className="p-3">{r.valorInicial}</td>
                  <td className="p-3">{r.valorFinal ?? '— (abierto)'}</td>
                  <td className="p-3">{new Date(r.fecha).toLocaleDateString()}</td>
                </tr>
              ))}
              {registros.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-4 text-muted-foreground">Sin registros.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add src/modules/terreno/horometro
git commit -m "feat(terreno): pantalla de registro de horómetro por turno"
```

---

### Task B6: Módulo Trabajos Extraordinarios (+ helper de monto)

**Files:**
- Create: `src/modules/terreno/trabajos-extra/schema.ts` (+ `schema.test.ts`), `.../api.ts`, `.../hooks.ts`, `.../TrabajosExtraPage.tsx`

**Interfaces:**
- Produces: `trabajoExtraFormSchema`, `TrabajoExtraForm`, `TrabajoExtraordinario`, `calcMonto`; `useTrabajosExtraList`, `useCreateTrabajoExtra`; `TrabajosExtraPage`.

- [ ] **Step 1: Escribir el test del schema + helper (falla primero)**

`.../trabajos-extra/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { trabajoExtraFormSchema, calcMonto } from './schema';

describe('trabajoExtraFormSchema', () => {
  it('rechaza horasMaquina <= 0', () => {
    const r = trabajoExtraFormSchema.safeParse({ equipoId: 'e1', cliente: 'X', horasMaquina: 0, tarifa: 100 });
    expect(r.success).toBe(false);
  });
});

describe('calcMonto', () => {
  it('multiplica horas por tarifa', () => {
    expect(calcMonto(12, 85000)).toBe(1020000);
  });
});
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npm test -- trabajos-extra`
Expected: FAIL ("Cannot find module './schema'").

- [ ] **Step 3: Crear el schema + helper**

`.../trabajos-extra/schema.ts`:

```ts
import { z } from 'zod';

export const trabajoExtraFormSchema = z.object({
  equipoId: z.string().min(1, 'Seleccioná un equipo'),
  cliente: z.string().min(1, 'Indicá el cliente'),
  horasMaquina: z.coerce.number().positive('Debe ser mayor a 0'),
  tonelaje: z.coerce.number().optional(),
  tarifa: z.coerce.number().positive('Debe ser mayor a 0'),
});

export type TrabajoExtraForm = z.infer<typeof trabajoExtraFormSchema>;

export function calcMonto(horasMaquina: number, tarifa: number): number {
  return Number((horasMaquina * tarifa).toFixed(2));
}

export interface TrabajoExtraordinario {
  id: string;
  equipoId: string;
  cliente: string;
  horasMaquina: number;
  tonelaje: number | null;
  tarifa: number;
  monto: number;
  fotoUrl: string | null;
  fecha: string;
  equipo?: { codigo: string };
}
```

- [ ] **Step 4: Correr el test (pasa)**

Run: `npm test -- trabajos-extra`
Expected: PASS (2 tests).

- [ ] **Step 5: Crear la capa api**

`.../trabajos-extra/api.ts`:

```ts
import { api } from '../../../shared/api/client';
import type { ApiResponse } from '../../../shared/api/types';
import type { TrabajoExtraForm, TrabajoExtraordinario } from './schema';

export async function listTrabajosExtra(): Promise<TrabajoExtraordinario[]> {
  const res = await api.get<ApiResponse<TrabajoExtraordinario[]>>('/trabajos-extra');
  return res.data.data;
}

export async function createTrabajoExtra(payload: TrabajoExtraForm): Promise<TrabajoExtraordinario> {
  const res = await api.post<ApiResponse<TrabajoExtraordinario>>('/trabajos-extra', payload);
  return res.data.data;
}
```

- [ ] **Step 6: Crear los hooks**

`.../trabajos-extra/hooks.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listTrabajosExtra, createTrabajoExtra } from './api';

const KEY = ['trabajos-extra'];

export function useTrabajosExtraList() {
  return useQuery({ queryKey: KEY, queryFn: listTrabajosExtra });
}

export function useCreateTrabajoExtra() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createTrabajoExtra,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
```

- [ ] **Step 7: Crear la página (con preview de monto en vivo)**

`.../trabajos-extra/TrabajosExtraPage.tsx`:

```tsx
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input } from '@heroui/react';
import { trabajoExtraFormSchema, calcMonto, type TrabajoExtraForm } from './schema';
import { useTrabajosExtraList, useCreateTrabajoExtra } from './hooks';
import { useEquipos } from '../../../shared/hooks/useEquipos';

const money = (n: number) => n.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' });

export function TrabajosExtraPage() {
  const { data: equipos = [] } = useEquipos();
  const { data: registros = [], isLoading } = useTrabajosExtraList();
  const crear = useCreateTrabajoExtra();

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors },
  } = useForm<TrabajoExtraForm>({
    resolver: zodResolver(trabajoExtraFormSchema),
    defaultValues: { equipoId: '', cliente: '', horasMaquina: 0, tarifa: 0 },
  });

  const horas = Number(useWatch({ control, name: 'horasMaquina' })) || 0;
  const tarifa = Number(useWatch({ control, name: 'tarifa' })) || 0;
  const montoPreview = calcMonto(horas, tarifa);

  const onSubmit = (values: TrabajoExtraForm) =>
    crear.mutate(values, { onSuccess: () => reset({ equipoId: '', cliente: '', horasMaquina: 0, tarifa: 0 }) });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Trabajos extraordinarios</h1>
        <p className="text-sm text-muted-foreground">Horas máquina × tarifa determinan el monto.</p>
      </header>

      <form
        onSubmit={handleSubmit(onSubmit)}
        className="grid gap-4 rounded-(--radius) border border-border bg-card p-4 sm:grid-cols-2"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Equipo</span>
          <select {...register('equipoId')} className="rounded-lg border border-border bg-background p-2">
            <option value="">Seleccioná…</option>
            {equipos.map((e) => (
              <option key={e.id} value={e.id}>{e.codigo} — {e.modelo}</option>
            ))}
          </select>
          {errors.equipoId && <span className="text-destructive text-xs">{errors.equipoId.message}</span>}
        </label>

        <Input label="Cliente" isInvalid={!!errors.cliente} errorMessage={errors.cliente?.message} {...register('cliente')} />
        <Input label="Horas máquina" type="number" step="0.1" isInvalid={!!errors.horasMaquina} errorMessage={errors.horasMaquina?.message} {...register('horasMaquina')} />
        <Input label="Tonelaje (opcional)" type="number" step="0.1" {...register('tonelaje')} />
        <Input label="Tarifa" type="number" step="1" isInvalid={!!errors.tarifa} errorMessage={errors.tarifa?.message} {...register('tarifa')} />

        <div className="flex items-end">
          <div className="rounded-lg bg-muted px-4 py-2 text-sm">
            Monto estimado: <span className="font-semibold text-primary">{money(montoPreview)}</span>
          </div>
        </div>

        <div className="sm:col-span-2">
          <Button type="submit" color="primary" isLoading={crear.isPending}>
            Registrar trabajo
          </Button>
        </div>
      </form>

      <section className="overflow-hidden rounded-(--radius) border border-border bg-card">
        {isLoading ? (
          <p className="p-4 text-muted-foreground">Cargando…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b border-border">
                <th className="p-3">Equipo</th>
                <th className="p-3">Cliente</th>
                <th className="p-3">Horas</th>
                <th className="p-3">Monto</th>
                <th className="p-3">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {registros.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="p-3">{r.equipo?.codigo ?? r.equipoId}</td>
                  <td className="p-3">{r.cliente}</td>
                  <td className="p-3">{r.horasMaquina}</td>
                  <td className="p-3 font-medium">{money(r.monto)}</td>
                  <td className="p-3">{new Date(r.fecha).toLocaleDateString()}</td>
                </tr>
              ))}
              {registros.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-4 text-muted-foreground">Sin registros.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add src/modules/terreno/trabajos-extra
git commit -m "feat(terreno): pantalla de trabajos extraordinarios con monto en vivo"
```

---

### Task B7: Módulo Hallazgos

**Files:**
- Create: `src/modules/terreno/hallazgos/schema.ts` (+ `schema.test.ts`), `.../api.ts`, `.../hooks.ts`, `.../HallazgosPage.tsx`

**Interfaces:**
- Produces: `hallazgoFormSchema`, `HallazgoForm`, `Hallazgo`, `CRITICIDADES`; `useHallazgosList`, `useCreateHallazgo`; `HallazgosPage`.

- [ ] **Step 1: Escribir el test del schema (falla primero)**

`.../hallazgos/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { hallazgoFormSchema } from './schema';

describe('hallazgoFormSchema', () => {
  it('acepta un hallazgo válido', () => {
    const r = hallazgoFormSchema.safeParse({ equipoId: 'e1', descripcion: 'Fuga', criticidad: 'ALTA' });
    expect(r.success).toBe(true);
  });

  it('rechaza criticidad inválida', () => {
    const r = hallazgoFormSchema.safeParse({ equipoId: 'e1', descripcion: 'Fuga', criticidad: 'URGENTE' });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npm test -- hallazgos`
Expected: FAIL ("Cannot find module './schema'").

- [ ] **Step 3: Crear el schema**

`.../hallazgos/schema.ts`:

```ts
import { z } from 'zod';

export const CRITICIDADES = ['BAJA', 'MEDIA', 'ALTA', 'CRITICA'] as const;

export const hallazgoFormSchema = z.object({
  equipoId: z.string().min(1, 'Seleccioná un equipo'),
  descripcion: z.string().min(3, 'Describí el hallazgo'),
  criticidad: z.enum(CRITICIDADES),
  fotoUrl: z.string().url('URL inválida').optional().or(z.literal('')),
});

export type HallazgoForm = z.infer<typeof hallazgoFormSchema>;

export interface Hallazgo {
  id: string;
  equipoId: string;
  descripcion: string;
  criticidad: string;
  estado: string;
  fotoUrl: string | null;
  fecha: string;
  equipo?: { codigo: string };
}
```

- [ ] **Step 4: Correr el test (pasa)**

Run: `npm test -- hallazgos`
Expected: PASS (2 tests).

- [ ] **Step 5: Crear la capa api**

`.../hallazgos/api.ts`:

```ts
import { api } from '../../../shared/api/client';
import type { ApiResponse } from '../../../shared/api/types';
import type { HallazgoForm, Hallazgo } from './schema';

export async function listHallazgos(): Promise<Hallazgo[]> {
  const res = await api.get<ApiResponse<Hallazgo[]>>('/hallazgos');
  return res.data.data;
}

export async function createHallazgo(payload: HallazgoForm): Promise<Hallazgo> {
  const body = { ...payload, fotoUrl: payload.fotoUrl || undefined };
  const res = await api.post<ApiResponse<Hallazgo>>('/hallazgos', body);
  return res.data.data;
}
```

- [ ] **Step 6: Crear los hooks**

`.../hallazgos/hooks.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listHallazgos, createHallazgo } from './api';

const KEY = ['hallazgos'];

export function useHallazgosList() {
  return useQuery({ queryKey: KEY, queryFn: listHallazgos });
}

export function useCreateHallazgo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createHallazgo,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
```

- [ ] **Step 7: Crear la página (con badges de criticidad/estado)**

`.../hallazgos/HallazgosPage.tsx`:

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Input } from '@heroui/react';
import { hallazgoFormSchema, CRITICIDADES, type HallazgoForm } from './schema';
import { useHallazgosList, useCreateHallazgo } from './hooks';
import { useEquipos } from '../../../shared/hooks/useEquipos';

const critClass: Record<string, string> = {
  BAJA: 'bg-muted text-muted-foreground',
  MEDIA: 'bg-primary/15 text-primary',
  ALTA: 'bg-destructive/15 text-destructive',
  CRITICA: 'bg-destructive text-destructive-foreground',
};

const estadoClass: Record<string, string> = {
  ABIERTO: 'bg-destructive/15 text-destructive',
  EN_PROCESO: 'bg-primary/15 text-primary',
  CERRADO: 'bg-muted text-muted-foreground',
};

function Badge({ text, cls }: { text: string; cls: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{text}</span>;
}

export function HallazgosPage() {
  const { data: equipos = [] } = useEquipos();
  const { data: hallazgos = [], isLoading } = useHallazgosList();
  const crear = useCreateHallazgo();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<HallazgoForm>({
    resolver: zodResolver(hallazgoFormSchema),
    defaultValues: { equipoId: '', descripcion: '', criticidad: 'MEDIA' },
  });

  const onSubmit = (values: HallazgoForm) =>
    crear.mutate(values, { onSuccess: () => reset({ equipoId: '', descripcion: '', criticidad: 'MEDIA' }) });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Hallazgos</h1>
        <p className="text-sm text-muted-foreground">Registrá un hallazgo con su criticidad; nace ABIERTO.</p>
      </header>

      <form
        onSubmit={handleSubmit(onSubmit)}
        className="grid gap-4 rounded-(--radius) border border-border bg-card p-4 sm:grid-cols-2"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Equipo</span>
          <select {...register('equipoId')} className="rounded-lg border border-border bg-background p-2">
            <option value="">Seleccioná…</option>
            {equipos.map((e) => (
              <option key={e.id} value={e.id}>{e.codigo} — {e.modelo}</option>
            ))}
          </select>
          {errors.equipoId && <span className="text-destructive text-xs">{errors.equipoId.message}</span>}
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Criticidad</span>
          <select {...register('criticidad')} className="rounded-lg border border-border bg-background p-2">
            {CRITICIDADES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>

        <div className="sm:col-span-2">
          <Input
            label="Descripción"
            isInvalid={!!errors.descripcion}
            errorMessage={errors.descripcion?.message}
            {...register('descripcion')}
          />
        </div>
        <Input label="Foto (URL)" isInvalid={!!errors.fotoUrl} errorMessage={errors.fotoUrl?.message} {...register('fotoUrl')} />

        <div className="sm:col-span-2">
          <Button type="submit" color="primary" isLoading={crear.isPending}>
            Registrar hallazgo
          </Button>
        </div>
      </form>

      <section className="overflow-hidden rounded-(--radius) border border-border bg-card">
        {isLoading ? (
          <p className="p-4 text-muted-foreground">Cargando…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b border-border">
                <th className="p-3">Equipo</th>
                <th className="p-3">Descripción</th>
                <th className="p-3">Criticidad</th>
                <th className="p-3">Estado</th>
                <th className="p-3">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {hallazgos.map((h) => (
                <tr key={h.id} className="border-b border-border last:border-0">
                  <td className="p-3">{h.equipo?.codigo ?? h.equipoId}</td>
                  <td className="p-3">{h.descripcion}</td>
                  <td className="p-3"><Badge text={h.criticidad} cls={critClass[h.criticidad] ?? ''} /></td>
                  <td className="p-3"><Badge text={h.estado} cls={estadoClass[h.estado] ?? ''} /></td>
                  <td className="p-3">{new Date(h.fecha).toLocaleDateString()}</td>
                </tr>
              ))}
              {hallazgos.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-4 text-muted-foreground">Sin hallazgos.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add src/modules/terreno/hallazgos
git commit -m "feat(terreno): pantalla de hallazgos con criticidad y estado"
```

---

### Task B8: Conectar rutas + verificación end-to-end

**Files:**
- Modify: `src/shared/router.tsx`

**Interfaces:**
- Consumes: las 4 páginas (Tasks B4–B7).
- Produces: rutas activas `/terreno/combustible|horometro|trabajos-extra|hallazgos` con redirect del index.

- [ ] **Step 1: Reescribir el router con las 4 rutas reales**

`src/shared/router.tsx`:

```tsx
import { createBrowserRouter, Navigate } from 'react-router';
import { AppLayout } from './layout/AppLayout';
import { CombustiblePage } from '../modules/terreno/combustible/CombustiblePage';
import { HorometroPage } from '../modules/terreno/horometro/HorometroPage';
import { TrabajosExtraPage } from '../modules/terreno/trabajos-extra/TrabajosExtraPage';
import { HallazgosPage } from '../modules/terreno/hallazgos/HallazgosPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/terreno/combustible" replace /> },
      { path: 'terreno/combustible', element: <CombustiblePage /> },
      { path: 'terreno/horometro', element: <HorometroPage /> },
      { path: 'terreno/trabajos-extra', element: <TrabajosExtraPage /> },
      { path: 'terreno/hallazgos', element: <HallazgosPage /> },
    ],
  },
]);
```

- [ ] **Step 2: Correr toda la suite de tests del front**

Run: `npm test`
Expected: PASS (combustible 3 + horómetro 2 + trabajos 2 + hallazgos 2 = 9 tests).

- [ ] **Step 3: Verificar el build de tipos**

Run: `npm run build`
Expected: `tsc -b` + `vite build` sin errores.

- [ ] **Step 4: Verificación end-to-end (con el backend corriendo)**

Preparar:
- Terminal 1 (backend): en `smi-backend`, `npm run start:dev`.
- Terminal 2 (frontend): en `smi-frontend`, `npm run dev`.

Verificar en el navegador (`http://localhost:5173`):
- [ ] El index redirige a Combustible; el sidebar muestra las 4 secciones.
- [ ] Combustible lista los 3 registros del seed; crear una carga con lectura actual muestra rendimiento y la fila aparece.
- [ ] Horómetro lista registros; crear una lectura con valor final funciona (y actualiza el equipo — verificable en Combustible al elegir ese equipo).
- [ ] Trabajos extra: el monto estimado cambia en vivo al tipear horas/tarifa; al crear, aparece en la tabla.
- [ ] Hallazgos: lista los 3 del seed con badges; crear uno nuevo aparece como ABIERTO.
- [ ] Cambiar el rol de dev a OPERADOR y crear un registro → el backend responde 403 (el guard stub bloquea). Volver a ADMIN/SUPERVISOR funciona.
- [ ] Sin errores en la consola del navegador.

- [ ] **Step 5: Commit**

```bash
git add src/shared/router.tsx
git commit -m "feat(terreno): conectar rutas de las 4 pantallas de terreno"
```

**FIN FASE B.** Bloque Operación en Terreno corriendo end-to-end.

---

## Cierre

- [ ] **Capturas para el PPT (§13):** una por pantalla (Combustible con rendimiento, Horómetro por turno, Trabajo extra con monto, Hallazgo con criticidad).
- [ ] **No hacer push.** Dejar las ramas `feat/terreno/scaffolding` listas en ambos repos; Alexander decide el PR. Recordar que la base provisional (Prisma/Equipo, guard stub, endpoint de equipos, store de rol) se reemplaza cuando aterrice el Sprint 0 real del equipo.
- [ ] **Integración futura (cuando exista Sprint 0):** borrar los `// PROVISIONAL`, apuntar a `schema.prisma` real (Equipo de Amin), reemplazar el guard stub por el de Better Auth, y `x-dev-role`/store de rol por `useSession()`.

## Notas de verificación cruzada con el spec

- §Combustible → Task A4 + B4. §Horómetro (incl. cierre actualiza equipo + gancho preventivo) → A5 + B5. §Trabajos extra (monto) → A6 + B6. §Hallazgos (default ABIERTO) → A7 + B7.
- §Base provisional backend (Prisma, common, main, equipos) → A1–A3. §Base provisional frontend (client, store, query, layout, router) → B1–B3.
- §Seed → A9. §Rutas `/api/...` → controllers A4–A7 + equipos A3. §Roles (Supervisor/Admin) → `@Roles` en A4–A7 + guard A2. §`{ data, message }` → interceptor/filtro A2.
- §Riesgo HeroUI/TW4 → resuelto (HeroUI v3, CSS import, sin provider) + decisión de UI documentada en cabecera Fase B.
