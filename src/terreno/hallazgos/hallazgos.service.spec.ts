import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HallazgosService } from './hallazgos.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import { StorageService } from '../../storage/storage.service';

describe('HallazgosService', () => {
  let service: HallazgosService;
  const prisma = {
    equipment: { findUnique: jest.fn() },
    hallazgo: { create: jest.fn() },
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
    const res = await service.create({
      equipoId: 'e1',
      descripcion: 'Fuga',
      prioridad: 'ALTA',
    }, 'u1');
    expect(res.estado).toBe('ABIERTO');
    expect(res.prioridad).toBe('ALTA');
  });

  it('emite HALLAZGO_CREATED con el id creado y los campos del hallazgo', async () => {
    await service.create({
      equipoId: 'e1',
      descripcion: 'Fuga',
      prioridad: 'ALTA',
    }, 'u1');

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

    /** Las dos juntas son ambiguas: no se sabe cuál es la foto de verdad. */
    it('rechaza fotoUrl y fotoKey a la vez', async () => {
      await expect(
        service.create(
          { ...base, fotoUrl: '/uploads/a.jpg', fotoKey: 'tmp/u1/x.jpg' },
          'u1',
        ),
      ).rejects.toThrow(/juntos/);
      expect(prisma.hallazgo.create).not.toHaveBeenCalled();
    });

    it('reclama la key temporal y devuelve la foto firmada, nunca la key', async () => {
      const res = await service.create({ ...base, fotoKey: 'tmp/u1/x.jpg' }, 'u1');

      expect(storage.claimTmp).toHaveBeenCalledWith('tmp/u1/x.jpg', 'u1', 'hallazgo-photo');
      expect(res.fotoUrl).toBe('https://signed.example/hallazgo-photos/tmp/u1/x.jpg');
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
      expect(storage.discard).toHaveBeenCalledWith('hallazgo-photos/tmp/u1/x.jpg');
    });

    /** Los hallazgos viejos siguen con su URL de /api/uploads y se ven igual. */
    it('deja pasar la fotoUrl legacy sin tocar el storage', async () => {
      const res = await service.create({ ...base, fotoUrl: '/uploads/vieja.jpg' }, 'u1');

      expect(storage.claimTmp).not.toHaveBeenCalled();
      expect(res.fotoUrl).toBe('/uploads/vieja.jpg');
    });
  });
});
