import { Test, type TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from '../../src/app.module';
import { configureApp, NEST_APP_CREATE_OPTIONS } from '../../src/app.setup';
import { PrismaService } from '../../src/common/prisma/prisma.service';

export interface BootstrappedApp {
  app: NestExpressApplication;
  prisma: PrismaService;
}

/**
 * Levanta la app Nest REAL (mismo pipeline que `main.ts`, vía `configureApp`)
 * para los e2e de este dominio — evita repetir el mismo
 * `Test.createTestingModule`/`app.init()` en cada archivo. El caller decide
 * cuándo cerrarla (`app.close()` en su propio `afterAll`) y qué agentes
 * loguear (`loginAgent`, de `login-agent.ts`).
 */
export async function bootstrapApp(): Promise<BootstrappedApp> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<NestExpressApplication>(
    NEST_APP_CREATE_OPTIONS,
  );
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  return { app, prisma };
}
