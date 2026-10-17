import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';

import { todayInBusinessTimeZone } from '../../common/dates/business-time';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { StockService } from '../../inventory/stock.service';
import type { StorageService } from '../../storage/storage.service';
import { DailyChecklistsService } from './daily-checklists.service';
import type { SubmitDailyChecklistDto } from './dto/submit-daily-checklist.dto';

const CATALOGO = [
  {
    id: 'chk_ac',
    name: 'Aire acondicionado',
    position: 1,
    requiresPhoto: true,
    requiresTemperature: true,
  },
  {
    id: 'chk_neumaticos',
    name: 'Neumáticos',
    position: 2,
    requiresPhoto: false,
    requiresTemperature: false,
  },
];

const EDITOR = { id: 'user_mantenedor', name: 'Mario Mantenedor' };
const HOY = todayInBusinessTimeZone(new Date());

function dto(
  overrides: Partial<SubmitDailyChecklistDto> = {},
): SubmitDailyChecklistDto {
  return {
    equipmentId: 'eq_1',
    date: HOY,
    counter: 2150,
    branchId: 'branch_faena',
    entries: [
      {
        itemId: 'chk_ac',
        status: 'CHECKED',
        temperature: 6,
        photoKeys: ['tmp/user/a.jpg'],
      },
      {
        itemId: 'chk_neumaticos',
        status: 'MAINTAINED',
        description: 'Se cambió una válvula',
        photoKeys: ['tmp/user/b.jpg'],
        supplies: [{ insumoId: 'item_1', cantidad: 2 }],
      },
    ],
    ...overrides,
  };
}

describe('DailyChecklistsService', () => {
  const prisma = {
    checklistItem: { findMany: jest.fn() },
    dailyChecklist: { findUnique: jest.fn(), findMany: jest.fn() },
    equipment: { findUnique: jest.fn(), findMany: jest.fn() },
    inventoryItem: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const txCreate = jest.fn();
  const storage = {
    claimTmp: jest.fn(),
    discard: jest.fn(),
    sign: jest.fn(),
  };
  const stock = { issue: jest.fn(), emitPending: jest.fn() };
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
    prisma.checklistItem.findMany.mockResolvedValue(CATALOGO);
    prisma.dailyChecklist.findUnique.mockResolvedValue(null);
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
      { id: 'item_1', sku: 'VAL-01', name: 'Válvula' },
    ]);
    prisma.$transaction.mockImplementation(
      (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ dailyChecklist: { create: txCreate } }),
    );
    txCreate.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 'chk_1',
        equipmentId: data.equipmentId,
        date: data.date,
        counter: data.counter,
        status: 'SUBMITTED',
        mechanicName: data.mechanicName,
        submittedAt: new Date(),
        submissionCount: 1,
        reviews: [],
        entries: (data.entries as { create: object[] }).create.map((e, i) => ({
          id: `entry_${i}`,
          ...e,
        })),
      }),
    );
    storage.claimTmp.mockImplementation((key: string) =>
      Promise.resolve(key.replace('tmp/user/', 'checklist-photos/')),
    );
    storage.sign.mockImplementation((key: string) =>
      Promise.resolve(`https://firmada/${key}`),
    );
  });

  it('guarda el checklist, descuenta los insumos y avisa al supervisor', async () => {
    const res = await service.submit(dto(), EDITOR);

    expect(storage.claimTmp).toHaveBeenCalledTimes(2);
    // El horómetro queda en el checklist; la lectura del equipo no se toca.
    const [{ data }] = txCreate.mock.calls[0] as [
      { data: { counter: number } },
    ];
    expect(data.counter).toBe(2150);
    expect(stock.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'item_1',
        branchId: 'branch_faena',
        quantity: 2,
        reason: 'INTERVENTION',
        equipmentId: 'eq_1',
        reference: 'chk_1',
      }),
      expect.anything(),
    );
    expect(stock.emitPending).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      DOMAIN_EVENTS.CHECKLIST_SUBMITTED,
      expect.objectContaining({
        checklistId: 'chk_1',
        equipmentCode: 'CA-011',
        declared: 2,
        maintained: 1,
        photos: 2,
      }),
    );
    expect(res.entries[1].supplies).toEqual([
      { itemId: 'item_1', sku: 'VAL-01', name: 'Válvula', quantity: 2 },
    ]);
    expect(res.entries[0].photos).toEqual([
      { id: 'a.jpg', url: 'https://firmada/checklist-photos/a.jpg' },
    ]);
  });

  it('rechaza un segundo checklist del mismo equipo y día', async () => {
    prisma.dailyChecklist.findUnique.mockResolvedValue({ id: 'otro' });
    await expect(service.submit(dto(), EDITOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(storage.claimTmp).not.toHaveBeenCalled();
  });

  it('rechaza un equipo que no existe', async () => {
    prisma.equipment.findUnique.mockResolvedValue(null);
    await expect(service.submit(dto(), EDITOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rechaza un horómetro menor que la lectura con que partió el equipo', async () => {
    await expect(
      service.submit(dto({ counter: 2099 }), EDITOR),
    ).rejects.toThrow('es menor que la lectura con que partió CA-011');
    expect(storage.claimTmp).not.toHaveBeenCalled();
  });

  it('rechaza una fecha fuera de la ventana', async () => {
    await expect(
      service.submit(dto({ date: '2020-01-01' }), EDITOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('aplica las reglas: una mantención de un crítico sin foto no pasa', async () => {
    const entries = dto().entries.map((e) =>
      e.itemId === 'chk_ac'
        ? {
            ...e,
            status: 'MAINTAINED' as const,
            description: 'Recarga',
            photoKeys: [],
          }
        : e,
    );
    await expect(
      service.submit(dto({ entries }), EDITOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('exige la bodega cuando hay insumos', async () => {
    await expect(
      service.submit(dto({ branchId: undefined }), EDITOR),
    ).rejects.toThrow('bodega');
  });

  it('descarta las fotos reclamadas si falla la transacción', async () => {
    stock.issue.mockRejectedValue(new BadRequestException('Sin stock'));
    await expect(service.submit(dto(), EDITOR)).rejects.toThrow('Sin stock');
    expect(storage.discard).toHaveBeenCalledWith('checklist-photos/a.jpg');
    expect(storage.discard).toHaveBeenCalledWith('checklist-photos/b.jpg');
    expect(events.emit).not.toHaveBeenCalled();
  });
});
