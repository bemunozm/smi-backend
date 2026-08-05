/**
 * Instancia única de PrismaClient para todo el proceso (una sola pool de
 * conexiones). El reto: `src/auth/auth.ts` construye `betterAuth(...)` en
 * import-time (fuera del ciclo de vida de Nest), mientras que el DI de Nest
 * solo existe en runtime, después de `NestFactory.create(...)`. Un
 * `PrismaService` inyectado normalmente por Nest no estaría disponible
 * todavía cuando `auth.ts` se importa.
 *
 * Solución: `prismaClient` es un singleton a nivel de módulo (Node cachea
 * los imports, así que siempre es el mismo objeto sin importar quién lo
 * importe). `auth.ts` lo importa directamente. `PrismaModule` lo expone
 * TAMBIÉN por DI vía `useValue`, para que los módulos de dominio lo inyecten
 * de la forma idiomática de Nest (`constructor(private prisma: PrismaService)`).
 * Como es la misma instancia en ambos caminos, nunca hay dos pools.
 *
 * Nest invoca los hooks de ciclo de vida (`OnModuleInit`/`OnModuleDestroy`)
 * sobre cualquier instancia registrada en el contenedor que los implemente,
 * incluidas las provistas con `useValue` — no hace falta `useClass` para
 * que se disparen.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Conexión a Postgres establecida (Prisma)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Conexión a Postgres cerrada (Prisma)');
  }
}

export const prismaClient = new PrismaService();
