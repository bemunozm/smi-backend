import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ChangeLogService } from '../../change-log/change-log.service';
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
      updateMany: jest.fn<
        Promise<{ count: number }>,
        [{ where: { id: { in: string[] } } }]
      >(),
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
      valorFinal: null,
      closeClientId: null,
      equipo: { internalCode: 'SEM05' },
    },
    {
      id: 'c2',
      fecha: new Date('2026-11-24T10:00:00.000Z'),
      valorFinal: null,
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
    supervisorId,
    supervisorNombre: 'Ana Temporal',
    inicio: new Date('2026-11-24T10:00:00.000Z'),
    fin: new Date('2026-11-24T18:05:00.000Z'),
    fotoKey: null,
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
        { provide: ChangeLogService, useValue: {} },
      ],
    }).compile();
    service = mod.get(InformesTemporalesService);
    jest.clearAllMocks();
    prisma.informeTemporal.findUnique.mockReset();
    prisma.registroHorometro.findMany.mockReset().mockResolvedValue(pendientes);
    prisma.$transaction.mockImplementation(
      (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
    );
    // Por defecto enlaza todas las que se le piden (ninguna la tomó otro informe).
    prisma.registroHorometro.updateMany.mockImplementation((args) =>
      Promise.resolve({ count: args.where.id.in.length }),
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

    // Pendientes: abiertas del supervisor, ya cerradas con un closeClientId
    // del lote, o cerradas por él sin informe (resto de un lote fallido).
    expect(prisma.registroHorometro.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          supervisorId: SUP,
          temporal: true,
          informeTemporalId: null,
          OR: [
            { valorFinal: null },
            { closeClientId: { in: ['cc-1', 'cc-2'] } },
            { valorFinal: { not: null }, closedById: SUP },
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
      where: { id: { in: ['c1', 'c2'] }, informeTemporalId: null },
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
      { ...pendientes[0], valorFinal: 1210, closeClientId: 'cc-1' },
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

  it('enlaza la tarjeta que quedó cerrada en un lote fallido aunque el reenvío ya no la traiga', async () => {
    // Intento online anterior: c1 se cerró, c2 falló y el cliente descartó la
    // operación. Al refrescar, c1 (cerrada) salió del formulario y el reenvío
    // trae solo c2, con un id de informe y closeClientId propios.
    prisma.registroHorometro.findMany.mockResolvedValue([
      { ...pendientes[0], valorFinal: 1210, closeClientId: 'cc-viejo' },
      pendientes[1],
    ]);
    prisma.informeTemporal.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(informeRow());

    await service.create(dto({ cierres: [cierre('c2', 'cc-2')] }), session);

    // c1 no se vuelve a cerrar: ya lo estaba.
    expect(closeCard).toHaveBeenCalledTimes(1);
    expect(closeCard.mock.calls[0][0]).toBe('c2');
    // …pero queda enlazada a este informe, y cuenta para el inicio.
    expect(prisma.registroHorometro.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['c1', 'c2'] }, informeTemporalId: null },
      data: { informeTemporalId: INFORME_ID },
    });
    expect(prisma.informeTemporal.create.mock.calls[0][0].data).toMatchObject({
      inicio: new Date('2026-11-24T10:00:00.000Z'),
    });
  });

  it('una ya cerrada que vuelve con otro closeClientId no se cierra de nuevo, solo se enlaza', async () => {
    prisma.registroHorometro.findMany.mockResolvedValue([
      { ...pendientes[0], valorFinal: 1210, closeClientId: 'cc-viejo' },
      pendientes[1],
    ]);
    prisma.informeTemporal.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(informeRow());

    await service.create(dto(), session);

    expect(closeCard).toHaveBeenCalledTimes(1);
    expect(closeCard.mock.calls[0][0]).toBe('c2');
    expect(
      prisma.registroHorometro.updateMany.mock.calls[0][0].where.id.in,
    ).toEqual(['c1', 'c2']);
  });

  it('si otra tarjeta ya quedó en otro informe, el enlace no cuadra y se deshace con 409', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(null);
    // Un envío concurrente se llevó una de las dos entre la consulta y el enlace.
    prisma.registroHorometro.updateMany.mockResolvedValue({ count: 1 });

    const err: unknown = await service
      .create(dto(), session)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'INFORME_TARJETAS_DESCUADRADAS',
    });
    // El error sale de DENTRO de la tx: la crea y el enlace se revierten juntos.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
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
      actividad: 1 as const,
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

describe('InformesTemporalesService (listar, corregir, eliminar)', () => {
  let service: InformesTemporalesService;
  const ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
  const SUP = 'sup_t1';
  const admin = buildSession('adm1', 'ADMIN', 'Admin Uno');
  const secre = buildSession('sec1', 'SECRETARIA', 'Sec Uno');

  const prisma = {
    informeTemporal: {
      findMany: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      findUnique: jest.fn(),
      update: jest.fn<unknown, [Record<string, unknown>]>(),
      delete: jest.fn<unknown, [Record<string, unknown>]>(),
    },
    $transaction: jest.fn(),
  };
  const removeCard = jest.fn<Promise<void>, [string, unknown]>();
  const record = jest.fn();
  const findFor = jest.fn();
  const sign = jest.fn();
  const deleteBestEffort = jest.fn();

  const tarjeta = (id: string, code: string) => ({
    id,
    equipo: {
      id: `e-${id}`,
      internalCode: code,
      type: 'T',
      brand: null,
      model: null,
    },
    operador: 'x',
    valorInicial: 1,
    valorFinal: 2,
    fuelLiters: null,
    adBlueLiters: null,
    pumpPhotoKey: null,
    fecha: new Date(),
    fechaSalida: null,
  });

  const row = (over: Record<string, unknown> = {}) => ({
    id: ID,
    numero: 3,
    fecha: new Date('2026-11-24T00:00:00.000Z'),
    turno: 'DIURNO',
    actividad1: 'Limpieza de cancha',
    actividad2: null,
    personal: [{ actividad: 1, operatorId: null, nombre: 'Juan Rojas' }],
    observaciones: null,
    supervisorResponsable1: 'Pedro Soto',
    supervisorResponsable2: null,
    supervisorId: SUP,
    supervisorNombre: 'Ana Temporal',
    inicio: new Date('2026-11-24T10:00:00.000Z'),
    fin: new Date('2026-11-24T18:05:00.000Z'),
    fotoKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    tarjetas: [tarjeta('c1', 'A'), tarjeta('c2', 'B')],
    ...over,
  });

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        InformesTemporalesService,
        { provide: PrismaService, useValue: prisma },
        { provide: ShiftsService, useValue: { removeCard } },
        { provide: StorageService, useValue: { sign, deleteBestEffort } },
        { provide: ChangeLogService, useValue: { record, findFor } },
      ],
    }).compile();
    service = mod.get(InformesTemporalesService);
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(
      (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
    );
    sign.mockResolvedValue('https://storage.local/signed/x.jpg');
    removeCard.mockResolvedValue(undefined);
    deleteBestEffort.mockResolvedValue(undefined);
  });

  it('la foto del report sale como URL firmada en list, mine y detalle, nunca la key', async () => {
    const conFoto = row({ fotoKey: 'trabajo-extra-photo/abc.jpg' });
    sign.mockImplementation((key: string) =>
      Promise.resolve(`https://storage.local/signed/${key}`),
    );
    prisma.informeTemporal.findMany.mockResolvedValue([conFoto]);
    prisma.informeTemporal.findUnique.mockResolvedValue(conFoto);

    const [lista] = await service.findAll({});
    const [mios] = await service.findMine(
      buildSession(SUP, 'SUPERVISOR_TEMPORAL'),
    );
    const detalle = await service.findOne(ID, admin);

    for (const res of [lista, mios, detalle]) {
      expect(res.fotoUrl).toBe(
        'https://storage.local/signed/trabajo-extra-photo/abc.jpg',
      );
      expect(res).not.toHaveProperty('fotoKey');
    }
    expect(sign).toHaveBeenCalledWith('trabajo-extra-photo/abc.jpg');
  });

  it('sin foto del report, fotoUrl es null y no se firma nada', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(row());

    const res = await service.findOne(ID, admin);

    expect(res.fotoUrl).toBeNull();
    expect(res).not.toHaveProperty('fotoKey');
    // Las tarjetas de `row()` no tienen foto de bomba: no hay nada que firmar.
    expect(sign).not.toHaveBeenCalled();
  });

  it('list filtra por rango', async () => {
    prisma.informeTemporal.findMany.mockResolvedValue([row()]);

    const res = await service.findAll({
      desde: '2026-11-01',
      hasta: '2026-11-30',
    });

    const arg = prisma.informeTemporal.findMany.mock.calls[0][0];
    expect(arg).toMatchObject({
      where: {
        fecha: {
          gte: new Date('2026-11-01T00:00:00.000Z'),
          lte: new Date('2026-11-30T00:00:00.000Z'),
        },
      },
      orderBy: { numero: 'desc' },
      take: 500,
    });
    expect(res[0].fecha).toBe('2026-11-24');
  });

  it('list sin rango no filtra por fecha', async () => {
    prisma.informeTemporal.findMany.mockResolvedValue([]);
    await service.findAll({});
    expect(prisma.informeTemporal.findMany.mock.calls[0][0]).toMatchObject({
      where: {},
    });
  });

  it('findMine trae solo los del supervisor de la sesión, del más nuevo al más viejo', async () => {
    prisma.informeTemporal.findMany.mockResolvedValue([row()]);

    const res = await service.findMine(
      buildSession(SUP, 'SUPERVISOR_TEMPORAL'),
    );

    expect(prisma.informeTemporal.findMany.mock.calls[0][0]).toMatchObject({
      where: { supervisorId: SUP },
      orderBy: { numero: 'desc' },
      take: 100,
    });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ id: ID, fecha: '2026-11-24' });
    expect(res[0].tarjetas.map((t) => t.equipo.internalCode)).toEqual([
      'A',
      'B',
    ]);
  });

  it('findOne de otro supervisor temporal da 403', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(row());
    const otro = buildSession('sup_otro', 'SUPERVISOR_TEMPORAL', 'Otro');

    await expect(service.findOne(ID, otro)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.findOne(ID, buildSession(SUP, 'SUPERVISOR_TEMPORAL')),
    ).resolves.toMatchObject({ id: ID });
    await expect(service.findOne(ID, secre)).resolves.toMatchObject({
      id: ID,
    });
  });

  it('findOne inexistente da 404', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(null);
    await expect(service.findOne(ID, admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('update registra ChangeLog y no toca tarjetas', async () => {
    prisma.informeTemporal.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ actividad1: 'Despeje' }));

    const res = await service.update(ID, { actividad1: 'Despeje' }, secre);

    expect(prisma.informeTemporal.update.mock.calls[0][0]).toMatchObject({
      where: { id: ID },
      data: { actividad1: 'Despeje' },
    });
    expect(record).toHaveBeenCalledTimes(1);
    const [, entity, entityId, editor, changes, action] = record.mock
      .calls[0] as [unknown, string, string, unknown, unknown[], string?];
    expect(entity).toBe('informe_temporal');
    expect(entityId).toBe(ID);
    expect(editor).toEqual({ id: 'sec1', name: 'Sec Uno' });
    expect(changes).toEqual([
      {
        field: 'actividad1',
        label: 'Actividad 1',
        before: 'Limpieza de cancha',
        after: 'Despeje',
      },
    ]);
    expect(action).toBeUndefined();
    expect(removeCard).not.toHaveBeenCalled();
    expect(res.actividad1).toBe('Despeje');
  });

  it('update sin cambios reales no escribe ni registra', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(row());
    await service.update(ID, { actividad1: 'Limpieza de cancha' }, secre);
    expect(prisma.informeTemporal.update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('update valida personal contra el resultado combinado', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(row());
    await expect(
      service.update(
        ID,
        { personal: [{ actividad: 2, nombre: 'Juan' }] },
        secre,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.informeTemporal.update).not.toHaveBeenCalled();
  });

  it('update inexistente da 404', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(null);
    await expect(
      service.update(ID, { actividad1: 'x' }, secre),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('delete borra cada tarjeta y luego el informe', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(row());
    const orden: string[] = [];
    removeCard.mockImplementation((id) => {
      orden.push(`card:${id}`);
      return Promise.resolve();
    });
    prisma.informeTemporal.delete.mockImplementation(() => {
      orden.push('informe');
      return Promise.resolve({});
    });

    await service.remove(ID, admin);

    expect(removeCard).toHaveBeenNthCalledWith(1, 'c1', admin);
    expect(removeCard).toHaveBeenNthCalledWith(2, 'c2', admin);
    expect(orden).toEqual(['card:c1', 'card:c2', 'informe']);
    expect(prisma.informeTemporal.delete).toHaveBeenCalledWith({
      where: { id: ID },
    });
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      'informe_temporal',
      ID,
      expect.anything(),
      expect.anything(),
      'DELETE',
    );
  });

  it('delete tolera tarjeta ya borrada', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(row());
    removeCard.mockRejectedValueOnce(new NotFoundException('ya no existe'));

    await service.remove(ID, admin);

    expect(removeCard).toHaveBeenCalledTimes(2);
    expect(prisma.informeTemporal.delete).toHaveBeenCalledTimes(1);
  });

  it('delete suelta la foto del report DESPUÉS de borrar el informe', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(
      row({ fotoKey: 'trabajo-extra-photo/abc.jpg' }),
    );
    const orden: string[] = [];
    prisma.informeTemporal.delete.mockImplementation(() => {
      orden.push('informe');
      return Promise.resolve({});
    });
    deleteBestEffort.mockImplementation(() => {
      orden.push('foto');
      return Promise.resolve();
    });

    await service.remove(ID, admin);

    expect(deleteBestEffort).toHaveBeenCalledWith(
      'trabajo-extra-photo/abc.jpg',
    );
    expect(orden).toEqual(['informe', 'foto']);
  });

  it('delete sin foto del report no toca el bucket', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(row());
    await service.remove(ID, admin);
    expect(deleteBestEffort).not.toHaveBeenCalled();
  });

  it('delete de un informe ya borrado no falla', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(null);
    await expect(service.remove(ID, admin)).resolves.toBeUndefined();
    expect(prisma.informeTemporal.delete).not.toHaveBeenCalled();
  });

  it('findChanges lee el historial de informe_temporal', async () => {
    findFor.mockResolvedValue([]);
    await service.findChanges(ID);
    expect(findFor).toHaveBeenCalledWith('informe_temporal', ID);
  });
});
