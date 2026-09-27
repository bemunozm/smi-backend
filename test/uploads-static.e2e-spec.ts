import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppModule } from '../src/app.module';
import { configureApp, NEST_APP_CREATE_OPTIONS } from '../src/app.setup';
import { UPLOAD_DIR } from '../src/uploads/uploads.controller';

/**
 * Ejercita `configureApp` completo (no solo el prefijo, como
 * `app.e2e-spec.ts`) para probar los headers de seguridad que
 * `useStaticAssets` agrega a `/uploads/*` — ver hallazgo ALTO A1 de la
 * revisión de seguridad de R2-storage. Escribe los archivos de prueba
 * directo a `UPLOAD_DIR` (sin pasar por `POST /api/uploads`/auth) porque lo
 * que se prueba acá es el middleware estático, no el endpoint de subida.
 */
describe('Static /uploads headers (e2e)', () => {
  let app: NestExpressApplication;
  const jpegName = `e2e-static-test-${Date.now()}.jpg`;
  const pdfName = `e2e-static-test-${Date.now()}.pdf`;
  const jpegPath = join(UPLOAD_DIR, jpegName);
  const pdfPath = join(UPLOAD_DIR, pdfName);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>(
      NEST_APP_CREATE_OPTIONS,
    );
    configureApp(app);
    await app.init();

    if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
    writeFileSync(jpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4\ntest', 'utf8'));
  });

  afterAll(async () => {
    rmSync(jpegPath, { force: true });
    rmSync(pdfPath, { force: true });
    await app.close();
  });

  it('sirve una imagen con nosniff + CSP restrictiva, sin forzar descarga', async () => {
    const response = await request(app.getHttpServer())
      .get(`/uploads/${jpegName}`)
      .expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('sirve un PDF con Content-Disposition: attachment (no se abre inline)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/uploads/${pdfName}`)
      .expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers['content-disposition']).toBe('attachment');
  });

  it('404 en un archivo inexistente (no filtra existencia por header distinto)', async () => {
    await request(app.getHttpServer())
      .get('/uploads/no-existe-nunca.jpg')
      .expect(404);
  });
});
