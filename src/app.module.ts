import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '@thallesp/nestjs-better-auth';

import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { PrismaModule } from './common/prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { MantenimientoModule } from './mantenimiento/mantenimiento.module';
import { UsersModule } from './users/users.module';
import { auth } from './auth/auth';

@Module({
  imports: [
    // Global para que los módulos de dominio puedan inyectar ConfigService
    // de forma idiomática. `auth.ts`/`main.ts` NO lo usan (corren fuera o
    // antes del ciclo de Nest) — leen `src/common/config/env.ts` directo,
    // que es la única fuente de verdad validada de env. Ver ese archivo.
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HealthModule,
    UsersModule,
    MantenimientoModule,
    AuthModule.forRoot({
      auth,
      // Tier 1 #1: CORS vive SOLO en main.ts (app.enableCors). Sin este
      // flag, AuthModule detecta `trustedOrigins` (array) y llama su
      // propio `enableCors` con methods limitados (sin PATCH/DELETE
      // completos) — doble configuración que solo "funciona" por orden de
      // middlewares. Con el flag, `trustedOrigins` sigue siendo usado por
      // Better Auth para su propia validación de origin/CSRF, pero ya no
      // dispara una segunda config de CORS a nivel de Nest.
      disableTrustedOriginsCors: true,
    }),
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
