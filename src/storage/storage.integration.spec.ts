import { spawnSync } from 'node:child_process';

import { StorageService } from './storage.service';

/**
 * Integración OPCIONAL contra un MinIO real (SIN mocks de `S3Client`) — se
 * salta automáticamente si MinIO no está arriba en `localhost:9000` (mismo
 * patrón que `src/ocr/ocr.integration.spec.ts`). Para correrla localmente:
 *   docker compose up -d minio minio-init
 *   npx jest storage.integration
 *
 * `describe` no puede ser async, así que la reachability se decide de forma
 * síncrona con `spawnSync` (fetch nativo de Node en un subproceso separado,
 * con su propio timeout implícito por el `execFileSync`-like call).
 */
function isMinioReachable(): boolean {
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

// Id con shape válido de userId de Better Auth (alfanumérico) — no necesita
// existir de verdad, `StorageService` no consulta la DB.
const USER_ID = 'e2estorageintegrationuser01';

const maybeDescribe = isMinioReachable() ? describe : describe.skip;

maybeDescribe('StorageService (integración real contra MinIO)', () => {
  let service: StorageService;

  beforeAll(() => {
    service = new StorageService();
  });

  it('putTmp -> claimTmp -> sign -> fetch 200 -> unsigned fetch 403 -> deleteBestEffort -> 404', async () => {
    // JPEG mínimo válido para la detección por magic bytes — el contenido
    // real no importa, MinIO lo guarda y lo sirve tal cual.
    const jpegBuffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    ]);

    const tmpKey = await service.putTmp(USER_ID, jpegBuffer);
    expect(tmpKey).toMatch(new RegExp(`^tmp/${USER_ID}/.+\\.jpg$`));

    const finalKey = await service.claimTmp(tmpKey, USER_ID, 'equipment-photo');
    expect(finalKey).toMatch(/^equipment-photos\/.+\.jpg$/);

    const signedUrl = await service.sign(finalKey);
    const signedResponse = await fetch(signedUrl);
    expect(signedResponse.status).toBe(200);
    const signedBody = Buffer.from(await signedResponse.arrayBuffer());
    expect(signedBody.equals(jpegBuffer)).toBe(true);

    const unsignedUrl = signedUrl.split('?')[0];
    const unsignedResponse = await fetch(unsignedUrl);
    expect(unsignedResponse.status).toBe(403);

    await service.deleteBestEffort(finalKey);

    const afterDeleteResponse = await fetch(signedUrl);
    expect(afterDeleteResponse.status).toBe(404);
  }, 20_000);
});
