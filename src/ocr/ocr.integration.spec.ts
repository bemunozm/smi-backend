import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { env } from '../common/config/env';
import { OcrService } from './ocr.service';

/**
 * Foto real usada para validar el pipeline manualmente (ver instrucciones
 * de la tarea) — NO vive en el repo ni committeada: se lee de
 * `OCR_TEST_IMAGE` (env var local, gitignored, ver `.env.example`) para no
 * dejar una ruta personal en el código versionado.
 */
const FUEL_PHOTO_PATH = process.env.OCR_TEST_IMAGE;
const MANIFEST_PATH = join(process.cwd(), 'ocr-python', 'models.manifest.json');

interface ModelsManifest {
  version: string;
  files: { file: string }[];
}

function modelsPresent(): boolean {
  if (!existsSync(MANIFEST_PATH)) return false;
  try {
    const manifest = JSON.parse(
      readFileSync(MANIFEST_PATH, 'utf8'),
    ) as ModelsManifest;
    return manifest.files.every((entry) =>
      existsSync(join(env.ocrModelsDir, entry.file)),
    );
  } catch {
    return false;
  }
}

function isPipelineTestable(): boolean {
  if (!FUEL_PHOTO_PATH || !existsSync(FUEL_PHOTO_PATH)) return false;
  if (!modelsPresent()) return false;
  try {
    execFileSync(
      env.pythonBin,
      ['-c', 'import cv2, numpy, onnxruntime, tokenizers, PIL'],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * El worker tarda ~0.9s en cargar los dos modelos ONNX tras `onModuleInit`
 * — en vez de asomarse a estado interno privado del servicio, reintenta la
 * lectura real (una request "worker no listo todavía" y una "worker ya
 * cargado" son indistinguibles desde afuera, ambas devuelven `UNREADABLE`)
 * hasta que deje de degradar por esa razón o venza el plazo.
 */
async function readWithRetry(
  service: OcrService,
  buffer: Buffer,
  originalFilename: string,
  deadlineMs: number,
): Promise<Awaited<ReturnType<OcrService['readFuelValueFrom']>>> {
  const start = Date.now();
  for (;;) {
    const result = await service.readFuelValueFrom(buffer, originalFilename);
    if (result.status !== 'UNREADABLE' || Date.now() - start > deadlineMs) {
      return result;
    }
    await sleep(300);
  }
}

// Integración OPCIONAL: corre el worker real (dos modelos ONNX, SIN mocks)
// sobre una foto real de surtidor. Se salta automáticamente si falta
// PYTHON_BIN + sus deps (onnxruntime/tokenizers/numpy/opencv/pillow), los
// archivos de `ocr-python/models/` (ver `models.manifest.json`), la env var
// OCR_TEST_IMAGE, o el archivo al que apunta — nunca rompe la suite. Para
// correrlo localmente:
//   1. Setear en tu `.env` LOCAL (gitignored, ver `.env.example`):
//      OCR_TEST_IMAGE="C:/ruta/a/tu/foto-surtidor-legible.jpg"
//      PYTHON_BIN="C:/ruta/a/tu/python3.12.exe"  (con ocr-python/requirements.txt instalado)
//   2. Copiar los modelos a ocr-python/models/ (ver ocr-python/README.md)
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

    const result = await readWithRetry(
      service,
      buffer,
      FUEL_PHOTO_PATH as string,
      20_000,
    );

    expect(result.value).toBe('183.089');
    expect(result.status).toBe('CONFIRMED');
    expect(result.confidence).toBeGreaterThan(0.3);
  }, 30_000);
});
