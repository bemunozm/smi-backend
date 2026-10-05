import { config } from 'dotenv';

/**
 * Acota el pool de Prisma de cada worker de Jest. Por defecto Prisma abre
 * `num_cpus * 2 + 1` conexiones y `getFichaEquipo` lanza ~15 consultas en
 * paralelo: con 6 workers arrancando a la vez, esa ráfaga de conexiones nuevas
 * contra el proxy de puertos de Docker Desktop (localhost:5434) pierde algunos
 * handshakes y Prisma responde P1001 "Can't reach database server" -> 500
 * intermitente en tests que no tienen nada de malo. Con un pool chico las
 * consultas se encolan en vez de abrir conexiones en ráfaga.
 *
 * Corre vía `setupFiles` (antes de importar la app), por eso carga `.env` aquí:
 * `ConfigModule` lo hace demasiado tarde para el singleton `prismaClient`.
 */
const E2E_POOL_SIZE = 4;

config({ quiet: true });

const url = process.env.DATABASE_URL;
if (url && !/[?&]connection_limit=/.test(url)) {
  process.env.DATABASE_URL = `${url}${url.includes('?') ? '&' : '?'}connection_limit=${E2E_POOL_SIZE}`;
}
