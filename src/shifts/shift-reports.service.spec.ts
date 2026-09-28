import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { DOMAIN_EVENTS } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreateShiftReportDto } from './dto/create-shift-report.dto';
import {
  REPORT_RATE_LIMIT_MAX_PER_WINDOW,
  REPORT_RATE_LIMIT_WINDOW_MS,
  ShiftReportsService,
} from './shift-reports.service';

jest.mock('./pdf/pdf-renderer', () => ({
  renderPdfBuffer: jest.fn(),
}));
import { renderPdfBuffer } from './pdf/pdf-renderer';

const mockedRenderPdfBuffer = renderPdfBuffer as jest.MockedFunction<
  typeof renderPdfBuffer
>;

// B5: espía la construcción del docDefinition (sin perder el resto del
// módulo, que `pdf-renderer` NO usa acá — mock sigue siendo la implementación
// REAL, solo envuelta para poder inspeccionar `supervisorName`).
jest.mock('./pdf/shift-report.pdf', () => {
  const actual = jest.requireActual<typeof import('./pdf/shift-report.pdf')>(
    './pdf/shift-report.pdf',
  );
  return {
    ...actual,
    buildShiftExitReportDocDefinition: jest.fn(
      actual.buildShiftExitReportDocDefinition,
    ),
  };
});
import { buildShiftExitReportDocDefinition } from './pdf/shift-report.pdf';

const mockedBuildShiftExitReportDocDefinition =
  buildShiftExitReportDocDefinition as jest.MockedFunction<
    typeof buildShiftExitReportDocDefinition
  >;

function prismaError(
  code: string,
  meta?: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('mocked prisma error', {
    code,
    clientVersion: 'test',
    meta,
  });
}

function buildSession(
  userId: string,
  name = 'Ana Soto',
  role = 'SUPERVISOR',
): UserSession {
  return {
    user: { id: userId, name, role },
    session: { id: 'session_1' },
  } as unknown as UserSession;
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** `shiftDate` relativo a "hoy" — mismo motivo que `iso()`, pero para
 * `assertShiftDateWithinWindow` (B2(b), compara contra `new Date()` real). */
function todayShiftDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function baseDto(
  overrides: Partial<CreateShiftReportDto> = {},
): CreateShiftReportDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    shiftDate: todayShiftDate(),
    shiftType: 'DIURNO',
    cardIds: ['22222222-2222-4222-8222-222222222222'],
    requestedAt: iso(),
    ...overrides,
  };
}

describe('ShiftReportsService', () => {
  let service: ShiftReportsService;
  const prisma = {
    shiftExitReport: {
      findUnique: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    shift: { findUnique: jest.fn() },
    registroHorometro: { findMany: jest.fn() },
  };
  const storage = {
    putServerFile: jest.fn(),
    deleteBestEffort: jest.fn(),
    sign: jest.fn(),
  };
  const eventEmitter = { emit: jest.fn() };

  const SHIFT = {
    id: 'shift_1',
    supervisorId: 'sup_1',
    date: new Date('2026-09-28T00:00:00.000Z'),
    type: 'DIURNO',
  };
  const CARD = {
    id: '22222222-2222-4222-8222-222222222222',
    equipoId: 'e1',
    operador: 'Pedro Pérez',
    valorInicial: 100,
    valorFinal: 108.5,
    fuelLiters: 40,
    observaciones: null,
    equipo: { internalCode: 'EX-001', type: 'Excavadora' },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const mod = await Test.createTestingModule({
      providers: [
        ShiftReportsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();
    service = mod.get(ShiftReportsService);

    prisma.shiftExitReport.findUnique.mockResolvedValue(null);
    // M2(a): sin reportes recientes por defecto — los tests del rate limit
    // lo sobreescriben.
    prisma.shiftExitReport.count.mockResolvedValue(0);
    prisma.shift.findUnique.mockResolvedValue(SHIFT);
    prisma.registroHorometro.findMany.mockResolvedValue([CARD]);
    mockedRenderPdfBuffer.mockResolvedValue(Buffer.from('%PDF-1.4'));
    storage.putServerFile.mockResolvedValue(
      'reports/shift-exit/2026/09/r1.pdf',
    );
    prisma.shiftExitReport.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        createdAt: new Date('2026-09-28T20:00:00.000Z'),
        ...data,
      }),
    );
  });

  describe('create', () => {
    it('genera el PDF, sube al storage, crea la fila y emite el evento DESPUÉS del commit', async () => {
      const session = buildSession('sup_1');
      const dto = baseDto();

      const res = await service.create(dto, session);

      expect(mockedRenderPdfBuffer).toHaveBeenCalledTimes(1);
      expect(storage.putServerFile).toHaveBeenCalledWith(
        'shift-exit-report',
        expect.any(Buffer),
        expect.objectContaining({ id: dto.id }),
      );
      expect(prisma.shiftExitReport.create).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.SHIFT_EXIT_REPORT_SENT,
        expect.objectContaining({
          shiftId: 'shift_1',
          cardCount: 1,
          supervisorName: 'Ana Soto',
        }),
      );
      expect(res.missingCardIds).toEqual([]);
      expect(res.cardCount).toBe(1);
      expect(res.fileName).toBe(
        `reporte-salida-${todayShiftDate()}-diurno.pdf`,
      );

      // Orden: el evento se emite DESPUÉS de que create() de Prisma resolvió.
      const createOrder =
        prisma.shiftExitReport.create.mock.invocationCallOrder[0];
      const emitOrder = eventEmitter.emit.mock.invocationCallOrder[0];
      expect(emitOrder).toBeGreaterThan(createOrder);
    });

    it('reintento idempotente (mismo id, mismo dueño): NO genera PDF ni emite evento', async () => {
      const session = buildSession('sup_1');
      prisma.shiftExitReport.findUnique.mockResolvedValue({
        id: 'r1',
        shiftId: 'shift_1',
        fileKey: 'reports/shift-exit/2026/09/r1.pdf',
        fileName: 'reporte-salida-2026-09-28-diurno.pdf',
        cardCount: 1,
        requestedAt: new Date(),
        createdAt: new Date(),
        createdById: 'sup_1',
        emailStatus: 'SENT',
      });
      prisma.registroHorometro.findMany.mockResolvedValue([{ id: CARD.id }]);

      const res = await service.create(baseDto(), session);

      expect(mockedRenderPdfBuffer).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(prisma.shiftExitReport.create).not.toHaveBeenCalled();
      expect(res.id).toBe('r1');
      expect(res.missingCardIds).toEqual([]);
    });

    it('id existente de OTRO usuario -> 409 ID_CONFLICT', async () => {
      const session = buildSession('sup_1');
      prisma.shiftExitReport.findUnique.mockResolvedValue({
        id: 'r1',
        shiftId: 'shift_1',
        fileKey: 'k',
        fileName: 'f.pdf',
        cardCount: 1,
        requestedAt: new Date(),
        createdAt: new Date(),
        createdById: 'otro-supervisor',
        emailStatus: 'SENT',
      });

      await expect(service.create(baseDto(), session)).rejects.toMatchObject({
        response: { code: 'ID_CONFLICT' },
      });
      expect(mockedRenderPdfBuffer).not.toHaveBeenCalled();
    });

    it('sin turno para (supervisor, fecha, tipo) -> 404 SHIFT_NOT_FOUND', async () => {
      prisma.shift.findUnique.mockResolvedValue(null);

      await expect(
        service.create(baseDto(), buildSession('sup_1')),
      ).rejects.toMatchObject({ response: { code: 'SHIFT_NOT_FOUND' } });
    });

    it('ninguna tarjeta encontrada -> 409 NO_CARDS', async () => {
      prisma.registroHorometro.findMany.mockResolvedValue([]);

      await expect(
        service.create(baseDto(), buildSession('sup_1')),
      ).rejects.toMatchObject({ response: { code: 'NO_CARDS' } });
      expect(mockedRenderPdfBuffer).not.toHaveBeenCalled();
    });

    it('robustez offline: genera el PDF con las tarjetas encontradas y devuelve missingCardIds con las que no', async () => {
      const dto = baseDto({
        cardIds: [CARD.id, '33333333-3333-4333-8333-333333333333'],
      });

      const res = await service.create(dto, buildSession('sup_1'));

      expect(mockedRenderPdfBuffer).toHaveBeenCalledTimes(1);
      expect(res.missingCardIds).toEqual([
        '33333333-3333-4333-8333-333333333333',
      ]);
      expect(res.cardCount).toBe(1);
    });

    it('P2002 al crear (carrera con el mismo id, mismo dueño): descarta el PDF nuevo y devuelve la fila existente', async () => {
      const session = buildSession('sup_1');
      prisma.shiftExitReport.create.mockRejectedValue(prismaError('P2002'));
      // Segunda llamada a findUnique (dentro del catch) trae la fila ganadora.
      prisma.shiftExitReport.findUnique
        .mockResolvedValueOnce(null) // chequeo inicial de idempotencia
        .mockResolvedValueOnce({
          id: '11111111-1111-4111-8111-111111111111',
          shiftId: 'shift_1',
          fileKey: 'reports/shift-exit/2026/09/winner.pdf',
          fileName: 'reporte-salida-2026-09-28-diurno.pdf',
          cardCount: 1,
          requestedAt: new Date(),
          createdAt: new Date(),
          createdById: 'sup_1',
          emailStatus: 'PENDING',
        });

      const res = await service.create(baseDto(), session);

      expect(storage.deleteBestEffort).toHaveBeenCalledWith(
        'reports/shift-exit/2026/09/r1.pdf',
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(res).not.toHaveProperty('fileKey'); // nunca se expone en la respuesta
      expect(res.id).toBe('11111111-1111-4111-8111-111111111111');
    });

    it('P2002 al crear pero la fila ganadora es de OTRO usuario -> 409 ID_CONFLICT', async () => {
      const session = buildSession('sup_1');
      prisma.shiftExitReport.create.mockRejectedValue(prismaError('P2002'));
      prisma.shiftExitReport.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: '11111111-1111-4111-8111-111111111111',
          shiftId: 'shift_1',
          fileKey: 'k',
          fileName: 'f.pdf',
          cardCount: 1,
          requestedAt: new Date(),
          createdAt: new Date(),
          createdById: 'otro-supervisor',
          emailStatus: 'PENDING',
        });

      await expect(service.create(baseDto(), session)).rejects.toMatchObject({
        response: { code: 'ID_CONFLICT' },
      });
      expect(storage.deleteBestEffort).toHaveBeenCalled();
    });

    it('requestedAt absurdo (>24h futuro) se rechaza con INVALID_CAPTURE_TIME', async () => {
      const dto = baseDto({ requestedAt: iso(25 * 60 * 60 * 1000) });
      await expect(
        service.create(dto, buildSession('sup_1')),
      ).rejects.toMatchObject({ response: { code: 'INVALID_CAPTURE_TIME' } });
      expect(prisma.shiftExitReport.findUnique).not.toHaveBeenCalled();
    });

    // B2(b) de la auditoría de seguridad.
    it('shiftDate de más de 8 días de antigüedad se rechaza con INVALID_SHIFT_DATE, ANTES de buscar el turno', async () => {
      const dto = baseDto({ shiftDate: '2020-01-01' });
      await expect(
        service.create(dto, buildSession('sup_1')),
      ).rejects.toMatchObject({ response: { code: 'INVALID_SHIFT_DATE' } });
      expect(prisma.shift.findUnique).not.toHaveBeenCalled();
    });

    // M2(a) de la auditoría de seguridad.
    describe('rate limit de reportes por turno (M2a)', () => {
      it(`el ${REPORT_RATE_LIMIT_MAX_PER_WINDOW + 1}º reporte NUEVO en la ventana de ${REPORT_RATE_LIMIT_WINDOW_MS / 60_000} min → 429 REPORT_RATE_LIMITED, sin generar el PDF`, async () => {
        prisma.shiftExitReport.count.mockResolvedValue(
          REPORT_RATE_LIMIT_MAX_PER_WINDOW,
        );

        expect.assertions(4);
        try {
          await service.create(baseDto(), buildSession('sup_1'));
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(HttpException);
          expect((error as HttpException).getStatus()).toBe(
            HttpStatus.TOO_MANY_REQUESTS,
          );
          expect((error as HttpException).getResponse()).toMatchObject({
            code: 'REPORT_RATE_LIMITED',
          });
        }
        expect(mockedRenderPdfBuffer).not.toHaveBeenCalled();
      });

      it('por debajo del tope, no limita', async () => {
        prisma.shiftExitReport.count.mockResolvedValue(
          REPORT_RATE_LIMIT_MAX_PER_WINDOW - 1,
        );

        await expect(
          service.create(baseDto(), buildSession('sup_1')),
        ).resolves.toBeDefined();
      });

      it('el conteo se acota al turno (shiftId) y a la ventana de tiempo', async () => {
        await service.create(baseDto(), buildSession('sup_1'));

        expect(prisma.shiftExitReport.count).toHaveBeenCalledWith({
          where: {
            shiftId: SHIFT.id,
            createdAt: { gte: expect.any(Date) as Date },
          },
        });
      });

      it('un reintento (replay) del MISMO id nunca se limita, aunque el turno ya esté en el tope', async () => {
        const dto = baseDto();
        prisma.shiftExitReport.findUnique.mockResolvedValue({
          id: dto.id,
          shiftId: 'shift_1',
          fileKey: 'reports/shift-exit/2026/09/r1.pdf',
          fileName: 'reporte.pdf',
          cardCount: 1,
          requestedAt: new Date(),
          createdAt: new Date(),
          createdById: 'sup_1',
          emailStatus: 'SENT',
        });
        prisma.shiftExitReport.count.mockResolvedValue(
          REPORT_RATE_LIMIT_MAX_PER_WINDOW + 5,
        );

        await expect(
          service.create(dto, buildSession('sup_1')),
        ).resolves.toBeDefined();
        expect(prisma.shiftExitReport.count).not.toHaveBeenCalled();
      });
    });

    // B5 de la auditoría de seguridad.
    describe('supervisorName truncado a 120 chars (B5)', () => {
      it('un nombre de más de 120 chars se trunca en el PDF y en el evento (correo)', async () => {
        const nombreLargo = 'A'.repeat(150);
        const session = buildSession('sup_1', nombreLargo);

        await service.create(baseDto(), session);

        const [docDefinition] = mockedBuildShiftExitReportDocDefinition.mock
          .calls[0] as [{ supervisorName: string }];
        expect(docDefinition.supervisorName).toHaveLength(120);
        expect(docDefinition.supervisorName).toBe('A'.repeat(120));

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          DOMAIN_EVENTS.SHIFT_EXIT_REPORT_SENT,
          expect.objectContaining({ supervisorName: 'A'.repeat(120) }),
        );
      });

      it('un nombre de 120 chars o menos no se toca', async () => {
        const session = buildSession('sup_1', 'Ana Soto');

        await service.create(baseDto(), session);

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          DOMAIN_EVENTS.SHIFT_EXIT_REPORT_SENT,
          expect.objectContaining({ supervisorName: 'Ana Soto' }),
        );
      });
    });
  });

  describe('getSignedFileUrl', () => {
    const REPORT = {
      id: 'r1',
      fileKey: 'reports/shift-exit/2026/09/r1.pdf',
      fileName: 'reporte.pdf',
      createdById: 'sup_1',
    };

    it('el creador puede descargar su propio reporte', async () => {
      prisma.shiftExitReport.findUnique.mockResolvedValue(REPORT);
      storage.sign.mockResolvedValue('https://minio.local/signed/r1.pdf');

      const url = await service.getSignedFileUrl('r1', buildSession('sup_1'));

      expect(url).toBe('https://minio.local/signed/r1.pdf');
      expect(storage.sign).toHaveBeenCalledWith(REPORT.fileKey, {
        fileName: REPORT.fileName,
      });
    });

    it('ADMIN puede descargar el reporte de otro supervisor', async () => {
      prisma.shiftExitReport.findUnique.mockResolvedValue(REPORT);
      storage.sign.mockResolvedValue('https://minio.local/signed/r1.pdf');

      await expect(
        service.getSignedFileUrl(
          'r1',
          buildSession('admin_1', 'Admin', 'ADMIN'),
        ),
      ).resolves.toBe('https://minio.local/signed/r1.pdf');
    });

    it('otro supervisor -> 403 NOT_OWNER', async () => {
      prisma.shiftExitReport.findUnique.mockResolvedValue(REPORT);

      await expect(
        service.getSignedFileUrl('r1', buildSession('otro-sup')),
      ).rejects.toMatchObject({ response: { code: 'NOT_OWNER' } });
    });

    it('reporte inexistente -> 404', async () => {
      prisma.shiftExitReport.findUnique.mockResolvedValue(null);

      await expect(
        service.getSignedFileUrl('no-existe', buildSession('sup_1')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
