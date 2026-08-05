import { Global, Module } from '@nestjs/common';

import { PrismaService, prismaClient } from './prisma.service';

/**
 * Global para que cualquier módulo de dominio pueda inyectar `PrismaService`
 * sin re-importar este módulo explícitamente. Usa `useValue` con el mismo
 * singleton `prismaClient` que consume `src/auth/auth.ts` — ver el
 * comentario en `prisma.service.ts` para el porqué.
 */
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: prismaClient }],
  exports: [PrismaService],
})
export class PrismaModule {}
