import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ChangeLogService } from '../../change-log/change-log.service';
import { todayInBusinessTimeZone } from '../../common/dates/business-time';
import { PrismaService } from '../../common/prisma/prisma.service';
import { buildSession, prismaError } from '../../common/testing/fixtures';
import { ShiftsService } from '../../shifts/shifts.service';
import { StorageService } from '../../storage/storage.service';
import { CreateInformeAntiguoDto } from './dto/create-informe-antiguo.dto';
import { InformesTemporalesService } from './informes-temporales.service';

/** «Subir informe antiguo»: sin tarjetas, con los equipos escritos a mano. */
describe('InformesTemporalesService — informe subido después', () => {
  let service: InformesTemporalesService;
  const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const SUP = 'sup_t1';
  const temporal = buildSession(SUP, 'SUPERVISOR_TEMPORAL', 'Ana Temporal');
  const admin = buildSession('adm1', 'ADMIN', 'Admin Uno');

  const prisma = {
    informeTemporal: {
      findUnique: jest.fn(),
      create: jest.fn<Promise<unknown>, [{ data: Record<string, unknown> }]>(),
      update: jest.fn<unknown, [{ data: Record<string, unknown> }]>(),
    },
    equipment: { findMany: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const claimTmp = jest.fn();
  const deleteBestEffort = jest.fn();
  const sign = jest.fn();
  const record = jest.fn();

  /** `YYYY-MM-DD` del día de negocio chileno de hace `dias` días. */
  const haceDias = (dias: number) =>
    todayInBusinessTimeZone(new Date(Date.now() - dias * 86_400_000));

  const dto = (
    over: Partial<CreateInformeAntiguoDto> = {},
  ): CreateInformeAntiguoDto => ({
    id: ID,
    numero: 12,
    fecha: haceDias(3),
    turno: 'DIURNO',
    actividad1: 'Limpieza de cancha',
    personal: [{ actividad: 1, operatorId: 'op1', nombre: 'Juan Rojas' }],
    supervisorResponsable1: 'Pedro Soto',
    equipos: [{ equipoId: 'e1', inicial: 484.92, final: 487.1 }],
    ...over,
  });

  const equipoRegistrado = {
    equipoId: 'e1',
    codigo: 'COMPRESOR',
    nombre: 'Compresor Kaeser M50',
    unidad: 'h',
    inicial: 484.92,
    final: 487.1,
    litros: null,
  };

  /** Fila guardada (con `include` de tarjetas, que un antiguo no tiene). */
  const row = (over: Record<string, unknown> = {}) => ({
    id: ID,
    numero: 12,
    antiguo: true,
    equiposRegistrados: [equipoRegistrado],
    fecha: new Date('2026-11-20T00:00:00.000Z'),
    turno: 'DIURNO',
    actividad1: 'Limpieza de cancha',
    actividad2: null,
    personal: [{ actividad: 1, operatorId: 'op1', nombre: 'Juan Rojas' }],
    observaciones: null,
    supervisorResponsable1: 'Pedro Soto',
    supervisorResponsable2: null,
    supervisorId: SUP,
    supervisorNombre: 'Ana Temporal',
    inicio: new Date('2026-11-20T15:00:00.000Z'),
    fin: new Date('2026-11-20T15:00:00.000Z'),
    fotoKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    tarjetas: [],
    ...over,
  });

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        InformesTemporalesService,
        { provide: PrismaService, useValue: prisma },
        { provide: ShiftsService, useValue: {} },
        {
          provide: StorageService,
          useValue: { claimTmp, sign, deleteBestEffort },
        },
        { provide: ChangeLogService, useValue: { record } },
      ],
    }).compile();
    service = mod.get(InformesTemporalesService);
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(
      (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
    );
    prisma.equipment.findMany.mockResolvedValue([
      {
        id: 'e1',
        internalCode: 'COMPRESOR',
        equipmentClass: 'HEAVY',
        type: 'Compresor',
        brand: 'Kaeser',
        model: 'M50',
      },
      {
        id: 'e2',
        internalCode: 'CAM-01',
        equipmentClass: 'LIGHT',
        type: 'Camioneta',
        brand: 'Toyota',
        model: 'Hilux',
      },
    ]);
    claimTmp.mockResolvedValue('trabajo-extra-photos/abc.jpg');
    sign.mockResolvedValue('https://storage.local/signed/x.jpg');
  });

  /** id libre, N° libre y la fila ya creada al releerla. */
  const conLibres = () =>
    prisma.informeTemporal.findUnique
      .mockResolvedValueOnce(null) // id (idempotencia)
      .mockResolvedValueOnce(null) // N° libre
      .mockResolvedValueOnce(row()); // relectura

  it('el supervisor temporal lo sube a su nombre, sin tarjetas y con los equipos a mano', async () => {
    conLibres();

    const res = await service.createAntiguo(
      dto({
        equipos: [
          { equipoId: 'e1', inicial: 484.92, final: 487.1 },
          { equipoId: 'e2', inicial: 45100, final: 45180, litros: 40 },
        ],
      }),
      temporal,
    );

    const data = prisma.informeTemporal.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      id: ID,
      numero: 12,
      antiguo: true,
      supervisorId: SUP,
      supervisorNombre: 'Ana Temporal',
      fotoKey: null,
      equiposRegistrados: [
        equipoRegistrado,
        {
          equipoId: 'e2',
          codigo: 'CAM-01',
          nombre: 'Camioneta Toyota Hilux',
          unidad: 'km',
          inicial: 45100,
          final: 45180,
          litros: 40,
        },
      ],
    });
    // Sin ventana real: inicio y fin caen dentro del día del informe.
    expect(data.inicio).toEqual(data.fin);
    expect(res.antiguo).toBe(true);
    expect(res.equiposRegistrados).toEqual([equipoRegistrado]);
    expect(res.tarjetas).toEqual([]);
  });

  it('reclama la foto del report en papel cuando viene', async () => {
    conLibres();
    await service.createAntiguo(dto({ fotoKey: 'tmp/sup_t1/x.jpg' }), temporal);
    expect(claimTmp).toHaveBeenCalledWith(
      'tmp/sup_t1/x.jpg',
      SUP,
      'trabajo-extra-photo',
    );
    expect(prisma.informeTemporal.create.mock.calls[0][0].data.fotoKey).toBe(
      'trabajo-extra-photos/abc.jpg',
    );
  });

  it('un N° ya tomado → 409 NUMERO_EN_USO sin reclamar la foto ni escribir', async () => {
    prisma.informeTemporal.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        fecha: new Date('2026-11-24T00:00:00.000Z'),
        supervisorNombre: 'Juan Torres',
      });

    await expect(
      service.createAntiguo(dto({ fotoKey: 'tmp/sup_t1/x.jpg' }), temporal),
    ).rejects.toMatchObject({
      response: {
        code: 'NUMERO_EN_USO',
        message:
          'El N° de informe 12 ya está registrado (Juan Torres, 24-11-2026).',
      },
    });
    expect(claimTmp).not.toHaveBeenCalled();
    expect(prisma.informeTemporal.create).not.toHaveBeenCalled();
  });

  it('el N° tomado justo entre medio (P2002) también es NUMERO_EN_USO', async () => {
    prisma.informeTemporal.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.informeTemporal.create.mockRejectedValueOnce(
      prismaError('P2002', { target: ['numero'] }),
    );
    await expect(
      service.createAntiguo(dto({ fotoKey: 'tmp/sup_t1/x.jpg' }), temporal),
    ).rejects.toMatchObject({ response: { code: 'NUMERO_EN_USO' } });
    // La foto reclamada por el intento fallido no queda huérfana.
    expect(deleteBestEffort).toHaveBeenCalledWith(
      'trabajo-extra-photos/abc.jpg',
    );
  });

  it('el reintento offline con el mismo id devuelve el ya creado', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(row());
    const res = await service.createAntiguo(dto(), temporal);
    expect(res.id).toBe(ID);
    expect(prisma.informeTemporal.create).not.toHaveBeenCalled();
  });

  it('el reintento de la oficina también vuelve con el suyo', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(row());
    const res = await service.createAntiguo(dto({ supervisorId: SUP }), admin);
    expect(res.id).toBe(ID);
  });

  it('final menor que inicial → 400 con el código del equipo', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(null);
    await expect(
      service.createAntiguo(
        dto({ equipos: [{ equipoId: 'e1', inicial: 500, final: 499 }] }),
        temporal,
      ),
    ).rejects.toThrow(/COMPRESOR: la lectura final/);
  });

  it('un equipo dos veces → 400', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(null);
    await expect(
      service.createAntiguo(
        dto({
          equipos: [
            { equipoId: 'e1', inicial: 1, final: 2 },
            { equipoId: 'e1', inicial: 2, final: 3 },
          ],
        }),
        temporal,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('una fecha futura → 400', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(null);
    await expect(
      service.createAntiguo(dto({ fecha: haceDias(-2) }), temporal),
    ).rejects.toMatchObject({ response: { code: 'INVALID_SHIFT_DATE' } });
  });

  it('el supervisor temporal no puede subirlo a nombre de otro', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValue(null);
    await expect(
      service.createAntiguo(dto({ supervisorId: 'otro' }), temporal),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('desde la oficina', () => {
    it('exige elegir el supervisor temporal', async () => {
      prisma.informeTemporal.findUnique.mockResolvedValue(null);
      await expect(service.createAntiguo(dto(), admin)).rejects.toThrow(
        'Elige a qué supervisor temporal pertenece el informe.',
      );
    });

    it('rechaza un usuario que no es supervisor temporal', async () => {
      prisma.informeTemporal.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({
        id: 'u9',
        name: 'Sup',
        email: 's@x',
        role: 'SUPERVISOR',
      });
      await expect(
        service.createAntiguo(dto({ supervisorId: 'u9' }), admin),
      ).rejects.toThrow('El usuario elegido no es un supervisor temporal.');
    });

    it('queda a nombre del supervisor temporal elegido', async () => {
      conLibres();
      prisma.user.findUnique.mockResolvedValue({
        id: 'sup_t2',
        name: 'Juan Torres',
        email: 'j@x',
        role: 'SUPERVISOR_TEMPORAL',
      });
      await service.createAntiguo(dto({ supervisorId: 'sup_t2' }), admin);
      expect(prisma.informeTemporal.create.mock.calls[0][0].data).toMatchObject(
        { supervisorId: 'sup_t2', supervisorNombre: 'Juan Torres' },
      );
    });
  });

  it('numeroLibre dice si el N° está tomado', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValueOnce(null);
    await expect(service.numeroLibre(5)).resolves.toEqual({
      numero: 5,
      libre: true,
    });
    prisma.informeTemporal.findUnique.mockResolvedValueOnce({ id: 'x' });
    await expect(service.numeroLibre(5)).resolves.toEqual({
      numero: 5,
      libre: false,
    });
  });

  describe('corregir sus equipos', () => {
    it('reemplaza los equipos y deja el antes y después en el historial', async () => {
      prisma.informeTemporal.findUnique
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row());

      await service.update(
        ID,
        {
          equipos: [
            { equipoId: 'e1', inicial: 484.92, final: 488, litros: 12 },
          ],
        },
        admin,
      );

      expect(
        prisma.informeTemporal.update.mock.calls[0][0].data.equiposRegistrados,
      ).toEqual([{ ...equipoRegistrado, final: 488, litros: 12 }]);
      const changes = record.mock.calls[0][4] as unknown[];
      expect(changes).toEqual([
        {
          field: 'equiposRegistrados',
          label: 'Equipos',
          before: 'COMPRESOR 484,92 → 487,1 h',
          after: 'COMPRESOR 484,92 → 488 h · 12 L',
        },
      ]);
    });

    it('los mismos equipos no son un cambio', async () => {
      prisma.informeTemporal.findUnique
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row());
      await service.update(
        ID,
        { equipos: [{ equipoId: 'e1', inicial: 484.92, final: 487.1 }] },
        admin,
      );
      expect(prisma.informeTemporal.update).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('en un informe normal es 400: sus equipos son tarjetas', async () => {
      prisma.informeTemporal.findUnique.mockResolvedValueOnce(
        row({ antiguo: false, equiposRegistrados: null }),
      );
      await expect(
        service.update(
          ID,
          { equipos: [{ equipoId: 'e1', inicial: 1, final: 2 }] },
          admin,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('un informe normal sale con equiposRegistrados vacío', async () => {
    prisma.informeTemporal.findUnique.mockResolvedValueOnce(
      row({ antiguo: false, equiposRegistrados: null }),
    );
    const res = await service.findOne(ID, admin);
    expect(res.equiposRegistrados).toEqual([]);
    expect(res.antiguo).toBe(false);
  });

  it('el 409 de un N° tomado es un ConflictException', async () => {
    prisma.informeTemporal.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ fecha: new Date(), supervisorNombre: 'X' });
    await expect(service.createAntiguo(dto(), temporal)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
