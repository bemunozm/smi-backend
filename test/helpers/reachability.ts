import { spawnSync } from 'node:child_process';

/** Chequeo TCP crudo contra el Postgres de e2e (`docker-compose.yml`, puerto
 * 5434) — permite que el archivo entero se salte (`describe.skip`) si no está
 * arriba, en vez de fallar cada test con un error de conexión. */
export function isPostgresReachable(): boolean {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "const net=require('net');const s=net.createConnection({host:'localhost',port:5434},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(3000,()=>{s.destroy();process.exit(1)});",
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
