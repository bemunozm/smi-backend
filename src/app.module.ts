import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthModule } from '@thallesp/nestjs-better-auth';

import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { PrismaModule } from './common/prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { MantenimientoModule } from './mantenimiento/mantenimiento.module';
import { UsersModule } from './users/users.module';
import { BranchModule } from './branch/branch.module';
import { EquipmentModule } from './equipment/equipment.module';
import { FichaModule } from './ficha/ficha.module';
import { FilesModule } from './files/files.module';
import { InventoryModule } from './inventory/inventory.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OcrModule } from './ocr/ocr.module';
import { TerrenoModule } from './terreno/terreno.module';
import { UploadsModule } from './uploads/uploads.module';
import { auth } from './auth/auth';

@Module({
  imports: [
    // Global para que los módulos de dominio puedan inyectar ConfigService
    // de forma idiomática. `auth.ts`/`main.ts` NO lo usan (corren fuera o
    // antes del ciclo de Nest) — leen `src/common/config/env.ts` directo,
    // que es la única fuente de verdad validada de env. Ver ese archivo.
    ConfigModule.forRoot({ isGlobal: true }),
    // Bus de eventos de dominio (Núcleo): los dominios emiten
    // `DOMAIN_EVENTS.*` (ver common/events/domain-events.ts) y
    // NotificationsModule los escucha para crear notificaciones/correos.
    EventEmitterModule.forRoot(),
    PrismaModule,
    HealthModule,
    UsersModule,
    MantenimientoModule,
    // Dominio Flota (Benjamín) — RFC T01, en inglés.
    EquipmentModule,
    // Plataforma (Benjamín): sucursales/bodegas base, las referencia Equipment.
    BranchModule,
    // Dominio Inventario (Joaquín) — RFC-3, modelo en inglés.
    InventoryModule,
    // Dominio Operación en Terreno (Alexander)
    TerrenoModule,
    UploadsModule,
    // Almacenamiento de archivos de Flota (RFC R2-storage): sube a `tmp/` vía
    // POST /api/files. El legacy UploadsModule/`/uploads` sigue intacto para
    // Terreno (horómetro/hallazgos) — fuera de alcance de este RFC.
    FilesModule,
    // Núcleo (Benjamín): OCR server-side de litros desde foto de surtidor.
    OcrModule,
    // Núcleo (Benjamín): ficha consolidada de un equipo, cruza los 4 dominios
    FichaModule,
    // Núcleo (Benjamín): notificaciones in-app + correo, alimentadas por el
    // bus de eventos de dominio
    NotificationsModule,
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
