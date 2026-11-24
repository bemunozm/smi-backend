import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../common/prisma/prisma.service';
import { buildSession } from '../../common/testing/fixtures';
import { ShiftsService } from '../../shifts/shifts.service';
import { StorageService } from '../../storage/storage.service';
import { CreateInformeTemporalDto } from './dto/create-informe-temporal.dto';
import { InformesTemporalesService } from './informes-temporales.service';

describe('InformesTemporalesService.create', () => {
  let service: InformesTemporalesService;
  const SUP = 'sup_t1';
  const session = buildSession(SUP, 'SUPERVISOR_TEMPORAL', 'Ana Temporal');
  const INFORME_ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

  const prisma = {
    informeTemporal: {
      findUnique: jest.fn(),
      create: jest.fn<unknown, [{ data: Record<string, unknown> }]>(),
    },
    registroHorometro: {
      findMany: jest.fn(),
      updateMany: jest.fn<unknown, [Record<string, unknown>]>(),
    },
    $transaction: jest.fn(),
  };
  const closeCard = jest.fn<
    Promise<unknown>,
    [string, Record<string, unknown>, unknown, unknown]
  >();
  const sign = jest.fn();

  /** Tarjetas pendientes (abiertas) del supervisor temporal. */
  const pendientes = [
    {
      id: 'c1',
      fecha: new Date('2026-11-24T11:00:00.000Z'),
      closeClientId: null,
      equipo: { internalCode: 'SEM05' },
    },
    {
      id: 'c2',
      fecha: new Date('2026-11-24T10:00:00.000Z'),
      closeClientId: null,
      equipo: { internalCode: 'WA470' },
    },
  ];

  const cierre = (cardId: string, closeClientId: string) => ({
    cardId,
    closeClientId,
    valorFinal: 1210,
    fuelLiters: 0,
    capturedAt: '2026-11-24T18:00:00.000Z',
  });

  const dto = (
    overrides: Partial<CreateInformeTemporalDto> = {},
  ): CreateInformeTemporalDto => ({
    id: INFORME_ID,
    fecha: '2026-11-24',
    turno: 'DIURNO',
    actividad1: 'Limpieza de cancha',
    personal: [{ actividad: 1, operatorId: 'op1', nombre: 'Juan Rojas' }],
    supervisorResponsable1: 'Pedro Soto',
    fotosEnviadas: true,
    infoSubidaApp: false,
    cierres: [cierre('c1', 'cc-1'), cierre('c2', 'cc-2')],
    ...overrides,
  });

  /** Fila como la devuelve `findUnique` con sus tarjetas incluidas. */
  const informeRow = (supervisorId = SUP) => ({
    id: INFORME_ID,
    numero: 1,
    fecha: new Date('2026-11-24T00:00:00.000Z'),
    turno: 'DIURNO',
    actividad1: 'Limpieza de cancha',
    actividad2: null,
    personal: [{ actividad: 1, operatorId: 'op1', nombre: 'Juan Rojas' }],
    observaciones: null,
    supervisorResponsable1: 'Pedro Soto',
    supervisorResponsable2: null,
    fotosEnviadas: true,
    infoSubidaApp: false,
    supervisorId,
    supervisorNombre: 'Ana Temporal',
    inicio: new Date('2026-11-24T10:00:00.000Z'),
    fin: new Date('2026-11-24T18:05:00.000Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
    tarjetas: [
      {
        id: 'c1',
        equipoId: 'e1',
        equipo: {
          id: 'e1',
          internalCode: 'SEM05',
          type: 'Cargador',
          brand: 'SEM',
          model: '656F',
        },
        operador: 'Juan Rojas',
        valorInicial: 1200,
        valorFinal: 1210,
        fuelLiters: 50,
        adBlueLiters: null,
        pumpPhotoKey: 'shift-card-photo/sup_t1/x.jpg',
        fecha: new Date('2026-11-24T11:00:00.000Z'),
        fechaSalida: new Date('2026-11-24T18:00:00.000Z'),
      },
    ],
  });

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        InformesTemporalesService,
        { provide: PrismaService, useValue: prisma },
        { provide: ShiftsService, useValue: { closeCard } },
        { provide: StorageService, useValue: { sign } },
      ],
    }).compile();
    service = mod.get(InformesTemporalesService);
    jest.clearAllMocks();
    prisma.informeTemporal.findUnique.mockReset();
    prisma.registroHorometro.findMany.mockReset().mockResolvedValue(pendientes);
    prisma.$transaction.mockImplementation(
      (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
    );
    closeCard.mockResolvedValue({});
    sign.mockResolvedValue('https://storage.local/signed/x.jpg');
  });

  it('cierra cada tarjeta con viaInforme y crea el informe enlazado', async () => {
    prisma.informeTemporal.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(informeRow());

    const res = await service.create(dto(), session);

    expect(closeCard).toHaveBeenCalledTimes(2);
    const [cardId, cierreDto, sesion, opts] = closeCard.mock.calls[0];
    expect(cardId).toBe('c1');
    expect(sesion).toBe(session);
    expect(opts).toEqual({ viaInforme: true });
    // `cardId` no viaja al cierre: el DTO de `closeCard` no lo conoce.
    expect(cierreDto).not.toHaveProperty('cardId');
    expect(cierreDto).toMatchObject({
      closeClientId: 'cc-1',
      valorFinal: 1210,
    });
    expect(closeCard.mock.calls[1][0]).toBe('c2');

    // Pendientes: abiertas del supervisor o ya cerradas con un closeClientId del lote.
    expect(prisma.registroHorometro.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          supervisorId: SUP,
          temporal: true,
          informeTemporalId: null,
          OR: [
            { valorFinal: null },
            { closeClientId: { in: ['cc-1', 'cc-2'] } },
          ],
        },
      }),
    );

    const data = prisma.informeTemporal.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      id: INFORME_ID,
      supervisorId: SUP,
      supervisorNombre: 'Ana Temporal',
      // inicio = la entrada más temprana de las tarjetas.
      inicio: new Date('2026-11-24T10:00:00.000Z'),
      fecha: new Date('2026-11-24T00:00:00.000Z'),
    });
    expect(data.fin).toBeInstanceOf(Date);
    expect(prisma.registroHorometro.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['c1', 'c2'] } },
      data: { informeTemporalId: INFORME_ID },
    });

    expect(res.numero).toBe(1);
    expect(res.fecha).toBe('2026-11-24');
    expect(res.tarjetas[0]).toEqual({
      id: 'c1',
      equipo: { id: 'e1', internalCode: 'SEM05', name: 'Cargador SEM 656F' },
      operador: 'Juan Rojas',
      valorInicial: 1200,
      valorFinal: 1210,
      fuelLiters: 50,
      adBlueLiters: null,
      pumpPhotoUrl: 'https://storage.local/signed/x.jpg',
      fecha: new Date('2026-11-24T11:00:00.000Z'),
      fechaSalida: new Date('2026-11-24T18:00:00.000Z'),
    });
    expect(res).not.toHaveProperty('tarjetas.0.pumpPhotoKey');
  });

  it('reintento con el mismo id devuelve el informe sin volver a cerrar', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(informeRow());

    const res = await service.create(dto(), session);

    expect(res.id).toBe(INFORME_ID);
    expect(closeCard).not.toHaveBeenCalled();
    expect(prisma.informeTemporal.create).not.toHaveBeenCalled();
  });

  it('un id ocupado por otro supervisor da 409 ID_CONFLICT', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(informeRow('otro'));

    await expect(service.create(dto(), session)).rejects.toMatchObject({
      response: { code: 'ID_CONFLICT' },
    });
    expect(closeCard).not.toHaveBeenCalled();
  });

  it('reintento tras corte a la mitad completa el lote', async () => {
    // c1 quedó cerrada en el intento anterior (con su closeClientId del lote):
    // la consulta de pendientes la sigue trayendo.
    prisma.registroHorometro.findMany.mockResolvedValue([
      { ...pendientes[0], closeClientId: 'cc-1' },
      pendientes[1],
    ]);
    prisma.informeTemporal.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(informeRow());

    await service.create(dto(), session);

    // closeCard es idempotente por closeClientId: se reintenta igual.
    expect(closeCard).toHaveBeenCalledTimes(2);
    expect(prisma.informeTemporal.create).toHaveBeenCalledTimes(1);
  });

  it('lote incompleto da 409 INFORME_TARJETAS_DESCUADRADAS con el código del equipo faltante', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(null);

    const err: unknown = await service
      .create(dto({ cierres: [cierre('c1', 'cc-1')] }), session)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('INFORME_TARJETAS_DESCUADRADAS');
    expect(body.message).toContain('WA470');
    expect(closeCard).not.toHaveBeenCalled();
    expect(prisma.informeTemporal.create).not.toHaveBeenCalled();
  });

  it('más de 10 personas en una actividad da 400', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(null);
    const personal = Array.from({ length: 11 }, (_, i) => ({
      actividad: 1,
      nombre: `Persona ${i}`,
    }));

    await expect(
      service.create(dto({ personal }), session),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(closeCard).not.toHaveBeenCalled();
  });

  it('personal de actividad 2 sin actividad2 da 400', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(null);

    await expect(
      service.create(
        dto({ personal: [{ actividad: 2, nombre: 'Juan Rojas' }] }),
        session,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(closeCard).not.toHaveBeenCalled();
  });
});
