import { BadRequestException, ConflictException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { StockService } from '../../inventory/stock.service';
import type { StorageService } from '../../storage/storage.service';
import { assertChecklistNotPending } from './checklist-gate';
import { DailyChecklistsService } from './daily-checklists.service';

const CATALOGO = [
  {
    id: 'chk_frenos',
    name: 'Pastillas de frenos',
    position: 1,
    requiresPhoto: true,
    requiresTemperature: false,
  },
  {
    id: 'chk_asiento',
    name: 'Asiento',
    position: 2,
    requiresPhoto: false,
    requiresTemperature: false,
  },
];

const SUPERVISOR = { id: 'user_supervisor', name: 'Sergio Supervisor' };
const MANTENEDOR = { id: 'user_mantenedor', name: 'Mario Mantenedor' };

/** Un checklist guardado, como lo devuelve Prisma con sus entradas y revisiones. */
function guardado(over: Record<string, unknown> = {}) {
  return {
    id: 'chk_1',
    equipmentId: 'eq_1',
    date: new Date('2026-10-16T00:00:00.000Z'),
    counter: 2150,
    status: 'SUBMITTED',
    mechanicId: MANTENEDOR.id,
    mechanicName: MANTENEDOR.name,
    submittedAt: new Date(),
    submissionCount: 1,
    branchId: 'branch_faena',
    entries: [
      {
        id: 'e1',
        itemId: 'chk_frenos',
        itemName: 'Pastillas de frenos',
        position: 1,
        status: 'MAINTAINED',
        description: 'Cambio de pastillas',
        note: null,
        temperature: null,
        photoKeys: ['checklist-photos/vieja.jpg', 'checklist-photos/otra.jpg'],
        supplies: [
          { itemId: 'item_1', sku: 'PAS-01', name: 'Pastilla', quantity: 2 },
        ],
      },
      {
        id: 'e2',
        itemId: 'chk_asiento',
        itemName: 'Asiento',
        position: 2,
        status: 'CHECKED',
        description: null,
        note: null,
        temperature: null,
        photoKeys: [],
        supplies: null,
      },
    ],
    reviews: [] as Record<string, unknown>[],
    ...over,
  };
}

describe('DailyChecklistsService · validación del supervisor (Módulo 3)', () => {
  const tx = {
    dailyChecklist: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    dailyChecklistReview: { create: jest.fn() },
    dailyChecklistEntry: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const prisma = {
    checklistItem: { findMany: jest.fn() },
    dailyChecklist: { findUnique: jest.fn() },
    equipment: { findUnique: jest.fn(), findMany: jest.fn() },
    inventoryItem: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const storage = { claimTmp: jest.fn(), discard: jest.fn(), sign: jest.fn() };
  const stock = {
    issue: jest.fn(),
    receive: jest.fn(),
    emitPending: jest.fn(),
  };
  const events = { emit: jest.fn() };
  let service: DailyChecklistsService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new DailyChecklistsService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      stock as unknown as StockService,
      events as unknown as EventEmitter2,
    );
    prisma.$transaction.mockImplementation(
      (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    );
    prisma.checklistItem.findMany.mockResolvedValue(CATALOGO);
    prisma.equipment.findUnique.mockResolvedValue({
      id: 'eq_1',
      internalCode: 'CA-011',
      controlUnit: 'HOURS',
      currentHourmeter: 2100,
      currentMileage: null,
    });
    prisma.equipment.findMany.mockResolvedValue([
      { id: 'eq_1', internalCode: 'CA-011' },
    ]);
    prisma.inventoryItem.findMany.mockResolvedValue([
      { id: 'item_2', sku: 'PAS-02', name: 'Pastilla reforzada' },
    ]);
    tx.dailyChecklist.updateMany.mockResolvedValue({ count: 1 });
    storage.sign.mockImplementation((k: string) => Promise.resolve(`url/${k}`));
    storage.claimTmp.mockImplementation((k: string) =>
      Promise.resolve(k.replace('tmp/user/', 'checklist-photos/')),
    );
  });

  describe('review', () => {
    it('aceptar deja la traza y avisa al mantenedor', async () => {
      prisma.dailyChecklist.findUnique.mockResolvedValue(guardado());
      tx.dailyChecklist.findUniqueOrThrow.mockResolvedValue(
        guardado({ status: 'ACCEPTED' }),
      );

      await service.review(
        'chk_1',
        { decision: 'ACCEPTED', submission: 1 },
        SUPERVISOR,
      );

      expect(tx.dailyChecklist.updateMany).toHaveBeenCalledWith({
        where: { id: 'chk_1', status: 'SUBMITTED', submissionCount: 1 },
        data: { status: 'ACCEPTED' },
      });
      expect(tx.dailyChecklistReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          decision: 'ACCEPTED',
          reviewerId: SUPERVISOR.id,
          reviewerName: SUPERVISOR.name,
          submission: 1,
        }) as unknown,
      });
      expect(events.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.CHECKLIST_REVIEWED,
        expect.objectContaining({
          decision: 'ACCEPTED',
          mechanicId: MANTENEDOR.id,
          equipmentCode: 'CA-011',
        }),
      );
    });

    it('rechazar exige un comentario', async () => {
      prisma.dailyChecklist.findUnique.mockResolvedValue(guardado());
      await expect(
        service.review(
          'chk_1',
          { decision: 'REJECTED', comment: ' ', submission: 1 },
          SUPERVISOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('el reintento sin señal de la misma decisión devuelve el checklist', async () => {
      prisma.dailyChecklist.findUnique.mockResolvedValue(
        guardado({
          status: 'ACCEPTED',
          reviews: [
            {
              decision: 'ACCEPTED',
              reviewerId: SUPERVISOR.id,
              reviewerName: SUPERVISOR.name,
              submission: 1,
              comment: null,
              createdAt: new Date(),
            },
          ],
        }),
      );
      const res = await service.review(
        'chk_1',
        { decision: 'ACCEPTED', submission: 1 },
        SUPERVISOR,
      );
      expect(res.status).toBe('ACCEPTED');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('no valida un envío que el mantenedor ya corrigió', async () => {
      prisma.dailyChecklist.findUnique.mockResolvedValue(
        guardado({ submissionCount: 2 }),
      );
      await expect(
        service.review(
          'chk_1',
          { decision: 'ACCEPTED', submission: 1 },
          SUPERVISOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('resubmit', () => {
    const correccion = {
      submission: 1,
      counter: 2150,
      branchId: 'branch_faena',
      entries: [
        {
          itemId: 'chk_frenos',
          status: 'MAINTAINED' as const,
          description: 'Cambio de pastillas, con foto del disco',
          // Conserva una foto vieja (por su id) y agrega una nueva.
          photoKeys: ['vieja.jpg', 'tmp/user/nueva.jpg'],
          supplies: [{ insumoId: 'item_2', cantidad: 1 }],
        },
        { itemId: 'chk_asiento', status: 'CHECKED' as const },
      ],
    };

    it('devuelve los insumos anteriores, descuenta los nuevos y conserva las fotos elegidas', async () => {
      prisma.dailyChecklist.findUnique.mockResolvedValue(
        guardado({ status: 'REJECTED' }),
      );
      tx.dailyChecklist.findUniqueOrThrow.mockResolvedValue(
        guardado({ status: 'SUBMITTED', submissionCount: 2 }),
      );

      await service.resubmit('chk_1', correccion, MANTENEDOR);

      expect(stock.receive).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'item_1',
          quantity: 2,
          reason: 'RETURN',
          branchId: 'branch_faena',
        }),
        expect.anything(),
      );
      expect(stock.issue).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'item_2', quantity: 1 }),
        expect.anything(),
      );
      const [{ data }] = tx.dailyChecklistEntry.createMany.mock.calls[0] as [
        { data: { itemId: string; photoKeys: string[] }[] },
      ];
      expect(data.find((e) => e.itemId === 'chk_frenos')?.photoKeys).toEqual([
        'checklist-photos/vieja.jpg',
        'checklist-photos/nueva.jpg',
      ]);
      // La foto que se quitó al corregir se borra recién al confirmar.
      expect(storage.discard).toHaveBeenCalledWith('checklist-photos/otra.jpg');
      expect(events.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.CHECKLIST_SUBMITTED,
        expect.objectContaining({ submission: 2 }),
      );
    });

    it('el horómetro ya enviado vale aunque la lectura del equipo haya subido después', async () => {
      prisma.dailyChecklist.findUnique.mockResolvedValue(
        guardado({ status: 'REJECTED' }),
      );
      tx.dailyChecklist.findUniqueOrThrow.mockResolvedValue(
        guardado({ submissionCount: 2 }),
      );
      // Al cerrar el turno la lectura subió a 2.300; el checklist traía 2.150.
      prisma.equipment.findUnique.mockResolvedValue({
        id: 'eq_1',
        internalCode: 'CA-011',
        controlUnit: 'HOURS',
        currentHourmeter: 2300,
        currentMileage: null,
      });
      await expect(
        service.resubmit('chk_1', correccion, MANTENEDOR),
      ).resolves.toBeDefined();
      await expect(
        service.resubmit('chk_1', { ...correccion, counter: 2200 }, MANTENEDOR),
      ).rejects.toThrow('es menor que la lectura');
    });

    it('solo se corrige un checklist rechazado', async () => {
      prisma.dailyChecklist.findUnique.mockResolvedValue(
        guardado({ status: 'ACCEPTED' }),
      );
      await expect(
        service.resubmit('chk_1', correccion, MANTENEDOR),
      ).rejects.toThrow('ya fue aceptado');
    });

    it('una foto que no era de ese ítem no se acepta', async () => {
      prisma.dailyChecklist.findUnique.mockResolvedValue(
        guardado({ status: 'REJECTED' }),
      );
      const ajena = {
        ...correccion,
        entries: [
          { ...correccion.entries[0], photoKeys: ['de-otro.jpg'] },
          correccion.entries[1],
        ],
      };
      await expect(
        service.resubmit('chk_1', ajena, MANTENEDOR),
      ).rejects.toThrow('ya no está en el checklist');
    });
  });
});

describe('assertChecklistNotPending (bloqueo del equipo)', () => {
  const db = { dailyChecklist: { findUnique: jest.fn() } };
  const hoy = new Date('2026-10-16T00:00:00.000Z');

  it.each([
    [null, false],
    [{ status: 'ACCEPTED' }, false],
    [{ status: 'SUBMITTED' }, true],
    [{ status: 'REJECTED' }, true],
  ])('checklist %j → bloquea: %s', async (fila, bloquea) => {
    db.dailyChecklist.findUnique.mockResolvedValue(fila);
    const intento = assertChecklistNotPending(db as never, 'eq_1', hoy);
    if (bloquea) {
      await expect(intento).rejects.toBeInstanceOf(ConflictException);
    } else {
      await expect(intento).resolves.toBeUndefined();
    }
  });
});
