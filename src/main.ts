import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';

import { env } from './common/config/env';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Better Auth necesita el body sin parsear; el paquete
    // @thallesp/nestjs-better-auth re-agrega los parsers por defecto
    // para el resto de las rutas.
    bodyParser: false,
  });

  // Tier 1 #1: única fuente de verdad de CORS (ver comentario en
  // app.module.ts sobre `disableTrustedOriginsCors`). Methods completos,
  // incluido PATCH, a diferencia del enableCors interno de AuthModule.
  app.enableCors({
    origin: env.frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // SECURITY-NOTES.md #B1 (resuelto): con los primeros DTOs de dominio
  // (UsersModule) ya hay body propio que validar fuera de Better Auth.
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

  // Tier 2 #8: permite que Nest invoque OnModuleDestroy (PrismaService)
  // ante SIGINT/SIGTERM, para cerrar el pool de Postgres limpiamente.
  app.enableShutdownHooks();

  await app.listen(env.port);
  Logger.log(
    `SMI backend escuchando en http://localhost:${env.port}`,
    'Bootstrap',
  );
}

void bootstrap();
