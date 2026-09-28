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
    hallazgo: { create: jest.fn(), findUnique: jest.fn() },
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
     * retiró en el cierre de R2 (RFC Supervisión en Terreno, Fase 3): ya no
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
});
