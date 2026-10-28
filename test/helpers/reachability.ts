import { spawnSync } from 'node:child_process';
import { config } from 'dotenv';

// El chequeo tiene que apuntar al MISMO Postgres que usarán los tests
// (`DATABASE_URL` de `.env`): antes el puerto estaba fijo en 5434 (un mapeo
// viejo) y el gate salteaba los e2e aunque el Postgres del compose (5433)
// estuviera arriba. `setupFiles` corre después de este import en algunos
// órdenes, así que se carga dotenv acá mismo (idempotente).
config({ quiet: true });

function postgresPortFromEnv(): number {
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      const port = new URL(url).port;
      if (port) return Number(port);
    } catch {
      // URL malformada: cae al default del compose.
    }
  }
  return 5433;
}

/** Chequeo TCP crudo contra el Postgres de e2e (`docker-compose.yml`) —
 * permite que el archivo entero se salte (`describe.skip`) si no está
 * arriba, en vez de fallar cada test con un error de conexión. */
export function isPostgresReachable(): boolean {
  const port = postgresPortFromEnv();
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const net=require('net');const s=net.createConnection({host:'localhost',port:${port}},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(3000,()=>{s.destroy();process.exit(1)});`,
    ],
    { timeout: 5000 },
  );
  return result.status === 0;
}

/** Mismo chequeo, para MinIO — solo lo necesitan los e2e que suben archivos
 * (ej. `shift-register`, foto del cierre de tarjeta). */
export function isMinioReachable(): boolean {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "fetch('http://localhost:9000/minio/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ],
    { timeout: 5000 },
  );
  return result.status === 0;
}
