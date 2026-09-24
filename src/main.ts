import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';

import { env } from './common/config/env';
import { AppModule } from './app.module';
import { configureApp, NEST_APP_CREATE_OPTIONS } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    NEST_APP_CREATE_OPTIONS,
  );

  configureApp(app);

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
