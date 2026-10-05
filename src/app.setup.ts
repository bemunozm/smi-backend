/**
 * Pipeline de configuración de la app, extraído de `main.ts` para que los
 * tests e2e (`test/*.e2e-spec.ts`) levanten EXACTAMENTE el mismo Nest app
 * (CORS, `ValidationPipe`, prefijo `/api`) que corre en producción — en vez
 * de reimplementar (y potencialmente desincronizar) su propio subset de esa
 * configuración.
 *
 * `NEST_APP_CREATE_OPTIONS` cubre la parte que NO se puede aplicar sobre un
 * `app` ya creado (el `bodyParser: false` se decide en `NestFactory.create`/
 * `TestingModule.createNestApplication`, antes de que exista la instancia) —
 * exportado como un único objeto para que main.ts y los e2e lo compartan sin
 * duplicar el literal.
 */
import { ValidationPipe } from '@nestjs/common';
import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { env } from './common/config/env';

// Better Auth necesita el body sin parsear; el paquete
// @thallesp/nestjs-better-auth re-agrega los parsers por defecto para el
// resto de las rutas.
export const NEST_APP_CREATE_OPTIONS: NestApplicationOptions = {
  bodyParser: false,
};

export function configureApp(app: NestExpressApplication): void {
  // Tier 1 #1: única fuente de verdad de CORS (ver comentario en
  // app.module.ts sobre `disableTrustedOriginsCors`). Methods completos,
  // incluido PATCH, a diferencia del enableCors interno de AuthModule.
  app.enableCors({
    origin: env.frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Ver SECURITY-NOTES.md: con los primeros DTOs de dominio (UsersModule)
  // ya hay body propio que validar fuera de Better Auth.
  // `whitelist` descarta props no declaradas en el DTO; `forbidNonWhitelisted`
  // rechaza la request si venían props extra (en vez de solo ignorarlas).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Prefijo global para las rutas propias de la API. No afecta al handler
  // de Better Auth: éste se registra como middleware crudo sobre su propio
  // basePath ('/api/auth'), al margen del prefijo global de Nest.
  app.setGlobalPrefix('api');

  // No se sirven archivos estáticos públicos: todo archivo (Flota y Terreno)
  // pasa por `POST /api/files` + storage privado firmado
  // (`StorageService.sign`). Ver SECURITY-NOTES.md.
}
