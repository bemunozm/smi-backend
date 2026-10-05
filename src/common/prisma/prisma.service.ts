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
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * `createdById` es el `user.id` del dueño de la fila: solo sirve para decidir
 * si un reintento con el mismo id de cliente es del mismo usuario, y nunca debe
 * salir en una respuesta. Se omite a nivel de cliente y no por consulta
 * porque `omit` por consulta NO se propaga a las relaciones incluidas
 * (`include: { homeBranch: true }` lo filtraría); el global sí. Donde el
 * código necesita leer al dueño lo pide explícito (`select: { createdById:
 * true }` u `omit: { createdById: false }`).
 *
 * Los tipos de Prisma siguen declarando `createdById` en cada fila: la clase
 * extiende el cliente sin parametrizar `omit` porque, parametrizado, el
 * `PrismaService` deja de ser asignable a `Prisma.TransactionClient` y los
 * helpers que aceptan ambos dejan de compilar. Por eso una lectura del dueño
 * sin `select`/`omit: false` compila y devuelve `undefined`; los e2e de
 * idempotencia (`ID_CONFLICT` para filas propias) lo detectan.
 */
const CLIENT_OPTIONS = {
  omit: {
    branch: { createdById: true },
    equipment: { createdById: true },
    equipmentDocument: { createdById: true },
    itemCategory: { createdById: true },
    inventoryItem: { createdById: true },
    registroCombustible: { createdById: true },
    shiftExitReport: { createdById: true },
    operator: { createdById: true },
    trabajoExtraordinario: { createdById: true },
    hallazgo: { createdById: true },
    ordenTrabajo: { createdById: true },
    intervencion: { createdById: true },
    umbralMantenimiento: { createdById: true },
    actividad: { createdById: true },
  },
} as const satisfies Prisma.PrismaClientOptions;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super(CLIENT_OPTIONS);
  }

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
