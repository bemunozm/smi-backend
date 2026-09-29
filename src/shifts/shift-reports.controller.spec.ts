import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { NextFunction, Request, Response } from 'express';

import { ShiftReportsController } from './shift-reports.controller';
import { ShiftReportsService } from './shift-reports.service';

const FAKE_SESSION = {
  user: { id: 'sup_1', name: 'Ana Soto', role: 'SUPERVISOR' },
};

describe('ShiftReportsController', () => {
  let app: INestApplication<App>;
  const create = jest.fn();
  const getSignedFileUrl = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ShiftReportsController],
      providers: [
        {
          provide: ShiftReportsService,
          useValue: { create, getSignedFileUrl },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // `@Session()` de @thallesp/nestjs-better-auth solo lee `request.session`
    // — sin el AuthGuard/middleware global de Better Auth acá (mismo patrón
    // que `files.controller.spec.ts`), se inyecta a mano.
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

  it('POST / delega en el service y devuelve {data, message}', async () => {
    create.mockResolvedValue({
      id: 'r1',
      shiftId: 'shift_1',
      fileName: 'reporte-salida-2026-09-28-diurno.pdf',
      cardCount: 2,
      requestedAt: new Date(),
      createdAt: new Date(),
      emailStatus: 'PENDING',
      missingCardIds: [],
    });

    const response = await request(app.getHttpServer())
      .post('/shift-reports')
      .send({
        id: '11111111-1111-4111-8111-111111111111',
        shiftDate: '2026-09-28',
        shiftType: 'DIURNO',
        cardIds: ['22222222-2222-4222-8222-222222222222'],
        requestedAt: new Date().toISOString(),
      })
      .expect(201);

    expect(create).toHaveBeenCalledTimes(1);
    const body = response.body as { data: { id: string }; message: string };
    expect(body.data.id).toBe('r1');
    expect(body.message).toBe('Reporte generado');
  });

  it('GET /:id/file responde 302 con Location = URL firmada', async () => {
    getSignedFileUrl.mockResolvedValue('https://minio.local/signed/r1.pdf');

    const response = await request(app.getHttpServer())
      .get('/shift-reports/r1/file')
      .expect(302);

    expect(response.headers.location).toBe('https://minio.local/signed/r1.pdf');
    expect(getSignedFileUrl).toHaveBeenCalledWith('r1', expect.anything());
  });

  it('GET /:id/file de otro supervisor -> 403', async () => {
    getSignedFileUrl.mockRejectedValue(
      new ForbiddenException({
        message: 'No puedes descargar el reporte de otro supervisor',
        code: 'NOT_OWNER',
      }),
    );

    await request(app.getHttpServer())
      .get('/shift-reports/r1/file')
      .expect(403);
  });

  it('GET /:id/file inexistente -> 404', async () => {
    getSignedFileUrl.mockRejectedValue(
      new NotFoundException('Reporte no encontrado'),
    );

    await request(app.getHttpServer())
      .get('/shift-reports/no-existe/file')
      .expect(404);
  });
});
