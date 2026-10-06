import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { env } from '../common/config/env';
import { OcrService } from './ocr.service';

/**
 * Foto real usada para validar el pipeline manualmente — NO vive en el repo
 * ni committeada: se lee de `OCR_TEST_IMAGE` (env var local, gitignored, ver
 * `.env.example`) para no dejar una ruta personal en el código versionado.
 */
const FUEL_PHOTO_PATH = process.env.OCR_TEST_IMAGE;
const HEALTH_PROBE_TIMEOUT_MS = 3_000;

/**
 * `describe`/`describe.skip` se decide al cargar el archivo, antes de que
 * exista un event loop libre para un `await`: se sondea `/health` en un
 * proceso hijo síncrono (mismo `fetch` nativo que usa `OcrService`).
 */
function isWorkerReady(): boolean {
  const probe = `
    fetch(process.argv[1] + '/health', { signal: AbortSignal.timeout(${HEALTH_PROBE_TIMEOUT_MS}) })
      .then((res) => res.json())
      .then((body) => process.exit(body && body.ready === true ? 0 : 1))
      .catch(() => process.exit(1));
  `;
  const result = spawnSync(process.execPath, ['-e', probe, env.ocrWorkerUrl], {
    stdio: 'ignore',
    timeout: HEALTH_PROBE_TIMEOUT_MS + 2_000,
  });
  return result.status === 0;
}

function isPipelineTestable(): boolean {
  if (!FUEL_PHOTO_PATH || !existsSync(FUEL_PHOTO_PATH)) return false;
  return isWorkerReady();
}

// Integración OPCIONAL: le pega al worker real (dos modelos ONNX, SIN mocks)
// con una foto real de surtidor. Se salta automáticamente si no hay un worker
// listo en OCR_WORKER_URL, o falta la env var OCR_TEST_IMAGE, o el archivo al
// que apunta — nunca rompe la suite. Para correrlo localmente:
//   1. Levantar el worker (ver ocr-python/README.md):
//      cd ocr-python && python worker.py        (puerto 8010 por defecto)
//      o el servicio `ocr-worker` de docker-compose.prod.yml.
//   2. Setear en tu `.env` LOCAL (gitignored, ver `.env.example`):
//      OCR_TEST_IMAGE="C:/ruta/a/tu/foto-surtidor-legible.jpg"
//      OCR_WORKER_URL="http://localhost:8010"   (si no es el default)
//   3. npm run test -- ocr.integration
const maybeDescribe = isPipelineTestable() ? describe : describe.skip;

maybeDescribe('OcrService (integración real, opcional)', () => {
  let service: OcrService;

  beforeAll(() => {
    service = new OcrService();
    service.onModuleInit();
  });

  afterAll(() => {
    service.onModuleDestroy();
  });

  it('lee 183.089 CONFIRMED de la foto real del surtidor', async () => {
    const buffer = readFileSync(FUEL_PHOTO_PATH as string);

    const result = await service.readFuelValue(buffer);

    expect(result.value).toBe('183.089');
    expect(result.status).toBe('CONFIRMED');
    expect(result.confidence).toBeGreaterThan(0.3);
  }, 30_000);
});
