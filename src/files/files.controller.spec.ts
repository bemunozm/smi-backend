import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { NextFunction, Request, Response } from 'express';

import { StorageService } from '../storage/storage.service';
import { FilesController } from './files.controller';

jest.mock('@aws-sdk/s3-request-presigner');

const mockedGetSignedUrl = getSignedUrl as jest.MockedFunction<
  typeof getSignedUrl
>;

interface ErrorBody {
  message: string;
}

interface UploadBody {
  data: { key: string; url: string };
  message: string;
}

/**
 * Usamos el `StorageService` REAL (no un mock) con `S3Client.prototype.send`
 * interceptado — así este spec ejercita la detección real de magic bytes
 * (`file-signature.ts`) end-to-end vía HTTP, no solo la conexión de cables
 * del controller. Solo se mockea el borde de red (S3/MinIO).
 */
describe('FilesController', () => {
  let app: INestApplication<App>;
  let sendSpy: jest.SpyInstance;

  const FAKE_SESSION = {
    user: { id: 'testuser1234567890123456', role: 'SUPERVISOR' },
  };

  beforeEach(async () => {
    // Ojo: mockResolvedValue encadenado directo sobre `jest.spyOn(...)` (sin
    // pasar por la variable `sendSpy` ya tipada como `jest.SpyInstance`)
    // rompe `tsc` — TS infiere el tipo de retorno específico y sobrecargado
    // de `S3Client.prototype.send`, que colapsa a `never` para el valor
    // resuelto. Se asigna primero y se mockea después.
    sendSpy = jest.spyOn(S3Client.prototype, 'send');
    sendSpy.mockResolvedValue({});
    mockedGetSignedUrl.mockResolvedValue('https://minio.local/signed-url');

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [StorageService],
    }).compile();

    app = moduleRef.createNestApplication();
    // `@Session()` de @thallesp/nestjs-better-auth solo lee `request.session`
    // — sin el AuthGuard/middleware global de Better Auth acá, lo inyectamos
    // a mano para simular una sesión SUPERVISOR ya autenticada.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { session: typeof FAKE_SESSION }).session =
        FAKE_SESSION;
      next();
    });
    await app.init();
    // `app.init()` dispara `StorageService.onModuleInit()` (HeadBucket no
    // bloqueante) — se limpia acá para que los asserts de cada test cuenten
    // solo las llamadas a S3 que dispara el propio request HTTP.
    sendSpy.mockClear();
  });

  afterEach(async () => {
    await app.close();
    sendSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('sin archivo devuelve 400 "No se recibió archivo"', async () => {
    const response = await request(app.getHttpServer())
      .post('/files')
      .expect(400);

    expect(response.body as ErrorBody).toMatchObject({
      message: 'No se recibió archivo',
    });
  });

  it('acepta un PDF real y devuelve {data:{key,url}, message}', async () => {
    const pdfBuffer = Buffer.from('%PDF-1.4\n%test pdf content', 'utf8');

    const response = await request(app.getHttpServer())
      .post('/files')
      .attach('file', pdfBuffer, 'revision.pdf')
      .expect(201);

    const body = response.body as UploadBody;
    expect(body.data.key).toMatch(/^tmp\/testuser1234567890123456\/.+\.pdf$/);
    expect(body.data.url).toBe('https://minio.local/signed-url');
    expect(body.message).toBe('Archivo subido');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('rechaza un HTML renombrado a .jpg con 415 (bytes reales no matchean)', async () => {
    const htmlBuffer = Buffer.from(
      '<!DOCTYPE html><html><body>hola</body></html>',
      'utf8',
    );

    const response = await request(app.getHttpServer())
      .post('/files')
      .attach('file', htmlBuffer, 'foto.jpg')
      .expect(415);

    expect((response.body as ErrorBody).message).toContain('no es una imagen');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('rechaza un SVG con 415 (texto, sin magic bytes binarios)', async () => {
    const svgBuffer = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'utf8',
    );

    const response = await request(app.getHttpServer())
      .post('/files')
      .attach('file', svgBuffer, 'foto.svg')
      .expect(415);

    expect((response.body as ErrorBody).message).toContain('no es una imagen');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('rechaza un archivo de más de 8MB con 413, sin llamar a S3', async () => {
    const oversizedBuffer = Buffer.alloc(8 * 1024 * 1024 + 1);

    const response = await request(app.getHttpServer())
      .post('/files')
      .attach('file', oversizedBuffer, 'foto-grande.jpg')
      .expect(413);

    expect((response.body as ErrorBody).message).toBeDefined();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('rechaza un mimetype que ni siquiera dice ser imagen/pdf (pre-filtro), sin llamar a S3', async () => {
    const textBuffer = Buffer.from('hola mundo', 'utf8');

    const response = await request(app.getHttpServer())
      .post('/files')
      .attach('file', textBuffer, {
        filename: 'notas.txt',
        contentType: 'text/plain',
      })
      .expect(400);

    expect((response.body as ErrorBody).message).toContain('imágenes o PDF');
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
