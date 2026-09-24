import { BadRequestException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { NextFunction, Request, Response } from 'express';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  imageOrPdfFileFilter,
  UPLOAD_DIR,
  UploadsController,
} from './uploads.controller';

/** Construye un `Express.Multer.File` mínimo — solo `mimetype` importa para el filtro. */
function mockFile(mimetype: string): Express.Multer.File {
  return { mimetype } as Express.Multer.File;
}

describe('imageOrPdfFileFilter (pre-filtro por mimetype)', () => {
  it('acepta un archivo de imagen', () => {
    const callback = jest.fn();

    imageOrPdfFileFilter({} as never, mockFile('image/png'), callback);

    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it('acepta un PDF', () => {
    const callback = jest.fn();

    imageOrPdfFileFilter({} as never, mockFile('application/pdf'), callback);

    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it('rechaza cualquier otro tipo de archivo con BadRequestException', () => {
    const callback = jest.fn();

    imageOrPdfFileFilter({} as never, mockFile('text/plain'), callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const [error, acceptFile] = callback.mock.calls[0] as [Error, boolean];
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe('Solo se permiten imágenes o PDF');
    expect(acceptFile).toBe(false);
  });
});

interface ErrorBody {
  message: string;
}

interface UploadBody {
  data: { url: string };
  message: string;
}

const FAKE_SESSION = {
  user: { id: 'testuser1234567890123456', role: 'SUPERVISOR' },
};

const JPEG_BUFFER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]);

/**
 * Suite HTTP end-to-end del controller (no mockea `detectFileSignature` ni
 * el filesystem) — ejercita el pipeline completo: pre-filtro por mimetype →
 * validación de bytes reales → nombre server-side → escritura a
 * `UPLOAD_DIR`. Ver hallazgo ALTO A1 de la revisión de seguridad: antes este
 * endpoint confiaba en `file.originalname`/mimetype del cliente.
 */
describe('UploadsController (HTTP)', () => {
  let app: INestApplication<App>;
  const writtenFiles: string[] = [];

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UploadsController],
    }).compile();

    app = moduleRef.createNestApplication();
    // `@Roles()` de @thallesp/nestjs-better-auth solo lee `request.session`
    // — sin el AuthGuard/middleware global acá, se inyecta a mano una sesión
    // SUPERVISOR ya autenticada (mismo patrón que `FilesController` spec).
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { session: typeof FAKE_SESSION }).session =
        FAKE_SESSION;
      next();
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    // Limpia SOLO los archivos que esta suite escribió — nunca borra el
    // resto de `UPLOAD_DIR` (puede tener archivos reales de Terreno).
    for (const filename of writtenFiles) {
      rmSync(join(UPLOAD_DIR, filename), { force: true });
    }
  });

  it('sin archivo devuelve 400 "No se recibió archivo"', async () => {
    const response = await request(app.getHttpServer())
      .post('/uploads')
      .expect(400);

    expect(response.body as ErrorBody).toMatchObject({
      message: 'No se recibió archivo',
    });
  });

  it('rechaza un HTML renombrado a .png con 415 (bytes reales no matchean) y no escribe nada a disco', async () => {
    const htmlBuffer = Buffer.from(
      '<!DOCTYPE html><html><body>hola</body></html>',
      'utf8',
    );
    const antes = readdirSync(UPLOAD_DIR).length;

    const response = await request(app.getHttpServer())
      .post('/uploads')
      .attach('file', htmlBuffer, 'foto.png')
      .expect(415);

    expect((response.body as ErrorBody).message).toContain('no es una imagen');
    expect(readdirSync(UPLOAD_DIR).length).toBe(antes);
  });

  it('rechaza un SVG con 415 (texto, sin magic bytes binarios)', async () => {
    const svgBuffer = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'utf8',
    );

    const response = await request(app.getHttpServer())
      .post('/uploads')
      .attach('file', svgBuffer, 'foto.svg')
      .expect(415);

    expect((response.body as ErrorBody).message).toContain('no es una imagen');
  });

  it('rechaza un mimetype que ni siquiera dice ser imagen/pdf (pre-filtro), sin tocar disco', async () => {
    const textBuffer = Buffer.from('hola mundo', 'utf8');
    const antes = readdirSync(UPLOAD_DIR).length;

    const response = await request(app.getHttpServer())
      .post('/uploads')
      .attach('file', textBuffer, {
        filename: 'notas.txt',
        contentType: 'text/plain',
      })
      .expect(400);

    expect((response.body as ErrorBody).message).toContain('imágenes o PDF');
    expect(readdirSync(UPLOAD_DIR).length).toBe(antes);
  });

  it('un JPEG real se guarda con extensión .jpg SIN IMPORTAR el nombre/extensión que mandó el cliente', async () => {
    const response = await request(app.getHttpServer())
      .post('/uploads')
      // El cliente miente la extensión (.html) pero declara un mimetype de
      // imagen válido (pasa el pre-filtro) — la extensión final SIEMPRE sale
      // de los bytes reales, nunca de este nombre.
      .attach('file', JPEG_BUFFER, {
        filename: 'foto-de-verdad.html',
        contentType: 'image/jpeg',
      })
      .expect(201);

    const body = response.body as UploadBody;
    expect(body.message).toBe('Archivo subido');
    expect(body.data.url).toMatch(/^\/uploads\/\d+-[0-9a-f]{16}\.jpg$/);

    const filename = body.data.url.replace('/uploads/', '');
    writtenFiles.push(filename);
    expect(existsSync(join(UPLOAD_DIR, filename))).toBe(true);
  });
});
