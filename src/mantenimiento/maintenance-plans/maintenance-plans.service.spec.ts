import { Test } from '@nestjs/testing';

import { PrismaService } from '../../common/prisma/prisma.service';
import { ChangeLogService } from '../../change-log/change-log.service';
import { MaintenancePlansService } from './maintenance-plans.service';
import type { SaveMaintenancePlanDto } from './dto/save-maintenance-plan.dto';

describe('MaintenancePlansService', () => {
  let service: MaintenancePlansService;
  const prisma = {
    equipment: { findUnique: jest.fn(), findMany: jest.fn() },
    maintenancePlan: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    maintenancePlanItem: { deleteMany: jest.fn(), createMany: jest.fn() },
    inventoryItem: { count: jest.fn() },
    $transaction: jest.fn(),
  };
  const changeLog = { record: jest.fn(), findFor: jest.fn() };
  const editor = { id: 'u1', name: 'Admin SMI' };

  const D6 = {
    id: 'e1',
    internalCode: 'BD-005',
    controlUnit: 'HOURS',
    currentHourmeter: 2100,
    currentMileage: null,
  };

  const pauta: SaveMaintenancePlanDto = {
    milestones: [500, 250, 2000, 1000],
    items: [
      {
        kind: 'FILTRO',
        description: 'Filtro aceite motor',
        quantity: 1,
        milestones: [250, 500, 1000, 2000],
      },
      {
        kind: 'ACEITE',
        description: 'Aceite motor 15W-40',
        quantity: 24,
        unit: 'LT',
        milestones: [250, 500, 1000, 2000],
      },
    ],
  };

  /** Lo que devuelve la base después de guardar: la pauta tal cual llegó. */
  const guardada = (dto: SaveMaintenancePlanDto) => ({
    id: 'p1',
    equipmentId: 'e1',
    milestones: [...dto.milestones].sort((a, b) => a - b),
    initialMilestone: dto.initialMilestone ?? null,
    updatedAt: new Date(),
    createdAt: new Date(),
    items: dto.items.map((i, position) => ({
      id: `i${position}`,
      planId: 'p1',
      position,
      kind: i.kind,
      description: i.description,
      quantity: i.quantity ?? null,
      unit: i.unit ?? null,
      partNumber: null,
      inventoryItemId: null,
      milestones: i.milestones,
    })),
  });

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        MaintenancePlansService,
        { provide: PrismaService, useValue: prisma },
        { provide: ChangeLogService, useValue: changeLog },
      ],
    }).compile();
    service = mod.get(MaintenancePlansService);
    jest.clearAllMocks();
    prisma.equipment.findUnique.mockResolvedValue(D6);
    prisma.maintenancePlan.findUnique.mockResolvedValue(null);
    prisma.maintenancePlan.upsert.mockResolvedValue({ id: 'p1' });
    prisma.maintenancePlan.findUniqueOrThrow.mockResolvedValue(guardada(pauta));
    prisma.$transaction.mockImplementation(
      (fn: (tx: typeof prisma) => unknown) => fn(prisma),
    );
  });

  it('guarda la pauta con los hitos ordenados y devuelve la próxima mantención', async () => {
    const res = await service.save('e1', pauta, editor);

    const [upsert] = prisma.maintenancePlan.upsert.mock.calls[0] as [
      { create: { milestones: number[] } },
    ];
    expect(upsert.create.milestones).toEqual([250, 500, 1000, 2000]);
    // BD-005 con 2.100 h: va en las 100 del ciclo de 2.000, toca la de 250.
    expect(res.status.next).toMatchObject({ milestone: 250, remaining: 150 });
    expect(res.status.next?.items).toHaveLength(2);
  });

  it('registra quién armó la pauta y qué tiene', async () => {
    await service.save('e1', pauta, editor);

    const llamada = changeLog.record.mock.calls[0] as unknown[];
    const cambios = llamada[4] as { label: string; after: string }[];
    expect(llamada.slice(1, 4)).toEqual(['maintenance_plan', 'e1', editor]);
    expect(cambios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Hitos',
          after: '250, 500, 1.000, 2.000',
        }),
        expect.objectContaining({
          label: 'Aceite motor 15W-40',
          after: '24 LT · hitos 250, 500, 1.000, 2.000',
        }),
      ]),
    );
  });

  it('no escribe nada si la pauta no cambió', async () => {
    prisma.maintenancePlan.findUnique.mockResolvedValue(guardada(pauta));

    await service.save('e1', pauta, editor);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(changeLog.record).not.toHaveBeenCalled();
  });

  it('rechaza una marca en un hito que no existe', async () => {
    await expect(
      service.save(
        'e1',
        {
          ...pauta,
          items: [{ ...pauta.items[0], milestones: [250, 750] }],
        },
        editor,
      ),
    ).rejects.toThrow(/750, que no es un hito/);
  });

  it('rechaza un servicio inicial que no va antes del primer hito', async () => {
    await expect(
      service.save('e1', { ...pauta, initialMilestone: 300 }, editor),
    ).rejects.toThrow(/tiene que ir antes del primer hito/);
  });

  it('rechaza una pauta sin hitos', async () => {
    await expect(
      service.save('e1', { milestones: [], items: [] }, editor),
    ).rejects.toThrow(/al menos un hito/);
  });

  it('rechaza un repuesto que no está en el inventario', async () => {
    prisma.inventoryItem.count.mockResolvedValue(0);

    await expect(
      service.save(
        'e1',
        { ...pauta, items: [{ ...pauta.items[0], inventoryItemId: 'x' }] },
        editor,
      ),
    ).rejects.toThrow(/ya no existe en el inventario/);
  });

  /** Los camiones se miden en km: la pauta usa su kilometraje. */
  it('usa el kilometraje en los equipos que se miden en km', async () => {
    prisma.equipment.findUnique.mockResolvedValue({
      ...D6,
      controlUnit: 'KM',
      currentHourmeter: null,
      currentMileage: 15500,
    });
    prisma.maintenancePlan.findUnique.mockResolvedValue(
      guardada({ milestones: [10000], items: [] }),
    );

    const res = await service.findForEquipment('e1');

    expect(res.equipment).toMatchObject({ unit: 'km', counter: 15500 });
    expect(res.status.next).toMatchObject({
      milestone: 10000,
      remaining: 4500,
    });
  });

  it('calcula la próxima mantención de todos los equipos con pauta en una consulta', async () => {
    prisma.maintenancePlan.findMany.mockResolvedValue([guardada(pauta)]);
    prisma.equipment.findMany.mockResolvedValue([D6]);

    const filas = await service.statusForAll();

    expect(prisma.equipment.findMany).toHaveBeenCalledTimes(1);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ equipmentId: 'e1', unit: 'h' });
    expect(filas[0].status.next?.milestone).toBe(250);
  });
});
