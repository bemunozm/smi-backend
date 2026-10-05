import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HallazgosService } from './hallazgos.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import { StorageService } from '../../storage/storage.service';
import { ChangeLogService } from '../../change-log/change-log.service';

describe('HallazgosService', () => {
  let service: HallazgosService;
  const prisma = {
    equipment: { findUnique: jest.fn() },
    hallazgo: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    // La corrección y su registro de cambios van en una sola transacción.
    $transaction: jest.fn(),
  };
  const eventEmitter = { emit: jest.fn() };
  // La foto ahora va al storage privado: `claimTmp` mueve la key temporal a su
  // lugar definitivo y `sign` la firma al devolverla.
  const storage = { claimTmp: jest.fn(), sign: jest.fn(), discard: jest.fn() };
  const changeLog = { record: jest.fn(), findFor: jest.fn() };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        HallazgosService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: StorageService, useValue: storage },
        { provide: ChangeLogService, useValue: changeLog },
      ],
    }).compile();
    service = mod.get(HallazgosService);
    jest.clearAllMocks();
    prisma.equipment.findUnique.mockResolvedValue({
      id: 'e1',
      internalCode: 'CA-011',
    });
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

  // El código del equipo viaja en el evento para que el aviso diga qué máquina es.
  it('emite HALLAZGO_CREATED con el id creado, el código del equipo y los campos del hallazgo', async () => {
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
        equipoCodigo: 'CA-011',
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

  /**
   * Acta N.° 004, R13: un hallazgo se corrige por error humano sin
   * autorización, pero queda registrado quién cambió qué y se avisa al
   * administrador.
   */
  describe('update', () => {
    const editor = { id: 'u1', name: 'Limbert Villacorta' };
    const guardado = {
      id: 'h1',
      equipoId: 'e1',
      equipo: { internalCode: 'CA-011' },
      descripcion: 'Fuga de aceite',
      prioridad: 'ALTA',
      estado: 'ABIERTO',
      fotoUrl: null,
      fotoKey: null,
      fecha: new Date(2026, 9, 1, 16, 25),
    };

    beforeEach(() => {
      prisma.hallazgo.findUnique.mockResolvedValue(guardado);
      prisma.hallazgo.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => ({
          ...guardado,
          ...data,
        }),
      );
      prisma.$transaction.mockImplementation(
        (fn: (tx: typeof prisma) => unknown) => fn(prisma),
      );
    });

    it('guarda la corrección y la registra con su antes y después legibles', async () => {
      const res = await service.update('h1', { prioridad: 'CRITICA' }, editor);

      expect(res.prioridad).toBe('CRITICA');
      expect(changeLog.record).toHaveBeenCalledWith(
        prisma,
        'hallazgo',
        'h1',
        editor,
        [
          {
            field: 'prioridad',
            label: 'Prioridad',
            before: 'Alta',
            after: 'Crítica',
          },
        ],
      );
    });

    it('avisa al administrador con el código del equipo nuevo', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: 'e2',
        internalCode: 'PE-004',
      });

      await service.update('h1', { equipoId: 'e2' }, editor);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.RECORD_EDITED,
        expect.objectContaining({
          entity: 'hallazgo',
          editedBy: 'Limbert Villacorta',
          changes: [{ label: 'Equipo', before: 'CA-011', after: 'PE-004' }],
        }),
      );
    });

    it('no registra ni avisa si nada cambió', async () => {
      await service.update('h1', { descripcion: ' Fuga de aceite ' }, editor);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
