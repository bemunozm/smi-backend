import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HallazgosService } from './hallazgos.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import { StorageService } from '../../storage/storage.service';

describe('HallazgosService', () => {
  let service: HallazgosService;
  const prisma = {
    equipment: { findUnique: jest.fn() },
    hallazgo: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };
  const eventEmitter = { emit: jest.fn() };
  // La foto ahora va al storage privado: `claimTmp` mueve la key temporal a su
  // lugar definitivo y `sign` la firma al devolverla.
  const storage = { claimTmp: jest.fn(), sign: jest.fn(), discard: jest.fn() };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        HallazgosService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    service = mod.get(HallazgosService);
    jest.clearAllMocks();
    prisma.hallazgo.findUnique.mockReset().mockResolvedValue(null);
    prisma.hallazgo.findFirst.mockReset().mockResolvedValue(null);
    prisma.hallazgo.create.mockReset();
    prisma.equipment.findUnique.mockResolvedValue({ id: 'e1' });
    storage.claimTmp.mockImplementation((key) => `hallazgo-photos/${key}`);
    storage.sign.mockImplementation((key) => `https://signed.example/${key}`);
    prisma.hallazgo.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 'h1',
        ...data,
      }),
    );
  });

  it('crea con estado ABIERTO y guarda la prioridad', async () => {
    const res = await service.create(
      {
        equipoId: 'e1',
        descripcion: 'Fuga',
        prioridad: 'ALTA',
      },
      'u1',
    );
    expect(res.estado).toBe('ABIERTO');
    expect(res.prioridad).toBe('ALTA');
  });

  it('emite HALLAZGO_CREATED con el id creado y los campos del hallazgo', async () => {
    await service.create(
      {
        equipoId: 'e1',
        descripcion: 'Fuga',
        prioridad: 'ALTA',
      },
      'u1',
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      DOMAIN_EVENTS.HALLAZGO_CREATED,
      {
        hallazgoId: 'h1',
        equipoId: 'e1',
        prioridad: 'ALTA',
        descripcion: 'Fuga',
      },
    );
  });

  describe('foto en storage privado', () => {
    const base = { equipoId: 'e1', descripcion: 'Fuga', prioridad: 'ALTA' };

    it('reclama la key temporal y devuelve la foto firmada, nunca la key', async () => {
      const res = await service.create(
        { ...base, fotoKey: 'tmp/u1/x.jpg' },
        'u1',
      );

      expect(storage.claimTmp).toHaveBeenCalledWith(
        'tmp/u1/x.jpg',
        'u1',
        'hallazgo-photo',
      );
      expect(res.fotoUrl).toBe(
        'https://signed.example/hallazgo-photos/tmp/u1/x.jpg',
      );
      expect('fotoKey' in res).toBe(false);
    });

    /**
     * El objeto ya está reclamado en el bucket. Si la fila no se escribe,
     * queda huérfano ocupando espacio y sin nada que lo referencie.
     */
    it('suelta la foto si la escritura falla', async () => {
      prisma.hallazgo.create.mockRejectedValueOnce(new Error('db caída'));

      await expect(
        service.create({ ...base, fotoKey: 'tmp/u1/x.jpg' }, 'u1'),
      ).rejects.toThrow('db caída');
      expect(storage.discard).toHaveBeenCalledWith(
        'hallazgo-photos/tmp/u1/x.jpg',
      );
    });

    /**
     * `fotoUrl` (legacy) ya no es un campo de `CreateHallazgoDto` — se
     * retiró en el cierre de R2 (RFC Supervisión en Terreno): ya no
     * se puede CREAR un hallazgo con ella, pero los hallazgos viejos que ya
     * la tienen siguen mostrándola tal cual en lectura (`findOne`/`shape`).
     */
    it('findOne devuelve fotoUrl legacy tal cual cuando el hallazgo no tiene fotoKey (dato histórico)', async () => {
      prisma.hallazgo.findUnique.mockResolvedValue({
        id: 'h1',
        equipoId: 'e1',
        descripcion: 'Fuga',
        prioridad: 'ALTA',
        estado: 'ABIERTO',
        fotoUrl: '/uploads/vieja.jpg',
        fotoKey: null,
        fecha: new Date(),
      });

      const res = await service.findOne('h1');

      expect(storage.claimTmp).not.toHaveBeenCalled();
      expect(res.fotoUrl).toBe('/uploads/vieja.jpg');
    });
  });

  describe('idempotencia (reenvío offline)', () => {
    const ID = 'b3b6a1f2-6c5e-4d0e-9a55-0f4f0a7d2c11';
    const base = {
      id: ID,
      equipoId: 'e1',
      descripcion: 'Fuga',
      prioridad: 'ALTA',
    };

    function createdData(): Record<string, unknown> {
      const [args] = prisma.hallazgo.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      return args.data;
    }

    function p2002(): Prisma.PrismaClientKnownRequestError {
      return new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      });
    }

    it('crea con el id del cliente, el dueño y la hora de captura como fecha', async () => {
      const capturedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();

      await service.create({ ...base, capturedAt }, 'u1');

      const data = createdData();
      expect(data.id).toBe(ID);
      expect(data.createdById).toBe('u1');
      expect(data.fecha).toEqual(new Date(capturedAt));
    });

    it('sin id ni capturedAt usa la hora del servidor y no consulta por id', async () => {
      const before = Date.now();
      const sinId = { ...base, id: undefined };

      await service.create(sinId, 'u1');

      const data = createdData();
      expect('id' in data).toBe(false);
      expect((data.fecha as Date).getTime()).toBeGreaterThanOrEqual(before);
      expect(prisma.hallazgo.findFirst).not.toHaveBeenCalled();
    });

    it('rechaza un capturedAt absurdo con 400 sin reclamar la foto ni escribir', async () => {
      await expect(
        service.create(
          {
            ...base,
            fotoKey: 'tmp/u1/x.jpg',
            capturedAt: '2001-01-01T00:00:00.000Z',
          },
          'u1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.claimTmp).not.toHaveBeenCalled();
      expect(prisma.hallazgo.create).not.toHaveBeenCalled();
    });

    it('el reintento del mismo usuario devuelve la fila existente sin reclamar, escribir ni emitir', async () => {
      prisma.hallazgo.findFirst.mockResolvedValue({
        id: ID,
        equipoId: 'e1',
        descripcion: 'Fuga',
        prioridad: 'ALTA',
        estado: 'ABIERTO',
        fotoUrl: null,
        fotoKey: 'hallazgo-photos/ya.jpg',
      });
      // Aunque el equipo ya no exista y la key tmp ya se haya consumido.
      prisma.equipment.findUnique.mockResolvedValue(null);

      const res = await service.create(
        { ...base, fotoKey: 'tmp/u1/x.jpg' },
        'u1',
      );

      expect(res.id).toBe(ID);
      expect(res.fotoUrl).toBe('https://signed.example/hallazgo-photos/ya.jpg');
      expect('fotoKey' in res).toBe(false);
      expect(prisma.equipment.findUnique).not.toHaveBeenCalled();
      expect(storage.claimTmp).not.toHaveBeenCalled();
      expect(prisma.hallazgo.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('otro usuario con el mismo id -> 409 ID_CONFLICT', async () => {
      prisma.hallazgo.findUnique.mockResolvedValue({ id: ID });

      await expect(service.create(base, 'u1')).rejects.toMatchObject({
        status: 409,
        response: { code: 'ID_CONFLICT' },
      });
      expect(prisma.hallazgo.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('una fila legacy sin dueño con ese id -> 409 ID_CONFLICT', async () => {
      prisma.hallazgo.findUnique.mockResolvedValue({ id: ID });

      await expect(service.create(base, 'u1')).rejects.toMatchObject({
        response: { code: 'ID_CONFLICT' },
      });
    });

    it('carrera P2002: suelta la foto reclamada, devuelve la fila propia y no emite', async () => {
      prisma.hallazgo.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: ID,
          equipoId: 'e1',
          fotoKey: 'hallazgo-photos/ganadora.jpg',
          fotoUrl: null,
        });
      prisma.hallazgo.create.mockRejectedValueOnce(p2002());

      const res = await service.create(
        { ...base, fotoKey: 'tmp/u1/x.jpg' },
        'u1',
      );

      expect(storage.discard).toHaveBeenCalledWith(
        'hallazgo-photos/tmp/u1/x.jpg',
      );
      expect(res.fotoUrl).toBe(
        'https://signed.example/hallazgo-photos/ganadora.jpg',
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('carrera P2002 contra otro usuario -> 409 ID_CONFLICT y suelta la foto', async () => {
      prisma.hallazgo.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: ID });
      prisma.hallazgo.create.mockRejectedValueOnce(p2002());

      await expect(
        service.create({ ...base, fotoKey: 'tmp/u1/x.jpg' }, 'u1'),
      ).rejects.toMatchObject({ response: { code: 'ID_CONFLICT' } });
      expect(storage.discard).toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('forma de la respuesta (equipo incluido, createdById oculto)', () => {
    const ID = 'b3b6a1f2-6c5e-4d0e-9a55-0f4f0a7d2c11';
    const INCLUDE = { equipo: { select: { internalCode: true } } };
    const OMIT = { createdById: true };
    const row = {
      id: ID,
      equipoId: 'e1',
      descripcion: 'Fuga',
      prioridad: 'ALTA',
      estado: 'ABIERTO',
      fotoUrl: null,
      fotoKey: null,
      equipo: { internalCode: 'EXC-01' },
    };
    const dto = {
      id: ID,
      equipoId: 'e1',
      descripcion: 'Fuga',
      prioridad: 'ALTA' as const,
    };

    function argsOf(
      fn: jest.Mock,
      call = 0,
    ): { include: unknown; omit: unknown } {
      return (fn.mock.calls[call] as [{ include: unknown; omit: unknown }])[0];
    }

    function expectQueryShape(fn: jest.Mock, call = 0): void {
      const args = argsOf(fn, call);
      expect(args.include).toEqual(INCLUDE);
      expect(args.omit).toEqual(OMIT);
    }

    it('create y findAll piden el mismo include y omiten createdById; la respuesta lleva equipo', async () => {
      prisma.hallazgo.create.mockResolvedValue(row);
      prisma.hallazgo.findMany.mockResolvedValue([row]);

      const created = await service.create(dto, 'u1');
      const [listed] = await service.findAll();

      expectQueryShape(prisma.hallazgo.create);
      expectQueryShape(prisma.hallazgo.findMany);
      expect(created).toHaveProperty('equipo', { internalCode: 'EXC-01' });
      expect(Object.keys(created).sort()).toEqual(Object.keys(listed).sort());
    });

    it('el replay idempotente usa la misma forma de query que create', async () => {
      prisma.hallazgo.findFirst.mockResolvedValue(row);

      const res = await service.create(dto, 'u1');

      expectQueryShape(prisma.hallazgo.findFirst);
      expect(res).toHaveProperty('equipo', { internalCode: 'EXC-01' });
    });

    it('la relectura tras P2002 usa la misma forma de query que create', async () => {
      prisma.hallazgo.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(row);
      prisma.hallazgo.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const res = await service.create(dto, 'u1');

      expectQueryShape(prisma.hallazgo.findFirst, 1);
      expect(res).toHaveProperty('equipo', { internalCode: 'EXC-01' });
    });

    it('findOne y update omiten createdById en la query', async () => {
      prisma.hallazgo.findUnique.mockResolvedValue(row);
      prisma.hallazgo.update.mockResolvedValue(row);

      await service.findOne(ID);
      await service.update(ID, {});

      expectQueryShape(prisma.hallazgo.findUnique);
      expectQueryShape(prisma.hallazgo.update);
    });

    it('el chequeo de propiedad filtra por dueño en la query, sin leer createdById', async () => {
      prisma.hallazgo.findFirst.mockResolvedValue(row);

      await service.create(dto, 'u1');

      const [args] = prisma.hallazgo.findFirst.mock.calls[0] as [
        { where: unknown },
      ];
      expect(args.where).toEqual({ id: ID, createdById: 'u1' });
    });
  });
});
