import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  ItemType,
  MovementReason,
  Prisma,
  UnitOfMeasure,
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ERROR_CODES } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StockService } from '../stock.service';
import { ItemsService } from './items.service';
import { UpdateItemDto } from './dto/update-item.dto';

function prismaError(
  code: string,
  meta?: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('mocked prisma error', {
    code,
    clientVersion: 'test',
    meta,
  });
}

describe('ItemsService', () => {
  let service: ItemsService;

  const findMany = jest.fn();
  const findUnique = jest.fn();
  const findUniqueOrThrow = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const deleteFn = jest.fn();
  const receive = jest.fn();
  const adjustToCount = jest.fn();
  const emitPending = jest.fn();
  const movementFindUnique = jest.fn();
  const queryRaw = jest.fn();

  const movementGroupBy = jest.fn();
  const equipmentFindMany = jest.fn();
  const compatDeleteMany = jest.fn();
  const compatUpsert = jest.fn();
  const compatFindMany = jest.fn();
  const compatDelegate = {
    deleteMany: compatDeleteMany,
    upsert: compatUpsert,
    findMany: compatFindMany,
  };

  const itemDelegate = {
    findMany,
    findUnique,
    findUniqueOrThrow,
    create,
    update,
    delete: deleteFn,
  };

  beforeEach(async () => {
    [
      findMany,
      findUnique,
      findUniqueOrThrow,
      create,
      update,
      deleteFn,
      receive,
      adjustToCount,
      emitPending,
      movementFindUnique,
      queryRaw,
      movementGroupBy,
      equipmentFindMany,
      compatDeleteMany,
      compatUpsert,
      compatFindMany,
    ].forEach((mock) => mock.mockReset());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ItemsService,
        {
          provide: PrismaService,
          useValue: {
            inventoryItem: itemDelegate,
            stockMovement: {
              findMany: jest.fn().mockResolvedValue([]),
              findUnique: movementFindUnique,
              groupBy: movementGroupBy,
            },
            equipment: { findMany: equipmentFindMany },
            partCompatibility: compatDelegate,
            // El create corre dentro de una transacción: el mock ejecuta el
            // callback con el mismo delegate, que es lo que hace Prisma.
            $transaction: (fn: (tx: unknown) => unknown) =>
              fn({
                inventoryItem: itemDelegate,
                partCompatibility: compatDelegate,
                $queryRaw: queryRaw,
              }),
          },
        },
        {
          provide: StockService,
          useValue: { receive, adjustToCount, emitPending },
        },
      ],
    }).compile();

    service = module.get<ItemsService>(ItemsService);
  });

  describe('create', () => {
    const dto = {
      sku: 'FIL-001',
      name: 'Filtro de aceite',
      initialQuantity: 10,
      branchId: 'b1',
    };

    it('registra la existencia inicial como entrada por compra', async () => {
      // El saldo nunca se escribe como columna suelta: si entrara sin asiento,
      // el primer renglón del kardex sería una existencia sin origen.
      create.mockResolvedValue({ id: 'i1' });
      findUniqueOrThrow.mockResolvedValue({ id: 'i1', sku: 'FIL-001' });

      await service.create(dto, 'u1');

      expect(receive).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'i1',
          branchId: 'b1',
          quantity: 10,
          reason: MovementReason.PURCHASE,
        }),
        expect.anything(),
      );
    });

    it('los avisos de existencia baja se emiten recién tras confirmar la transacción', async () => {
      create.mockResolvedValue({ id: 'i1' });
      findUniqueOrThrow.mockResolvedValue({ id: 'i1' });

      await service.create(dto, 'u1');

      expect(emitPending).toHaveBeenCalledTimes(1);
    });

    it('si la transacción falla, no se emite ningún aviso', async () => {
      create.mockResolvedValue({ id: 'i1' });
      receive.mockRejectedValue(new Error('boom'));

      await expect(service.create(dto, 'u1')).rejects.toThrow('boom');

      expect(emitPending).not.toHaveBeenCalled();
    });

    describe('id del cliente (reintento offline)', () => {
      const ID = '11111111-1111-4111-8111-111111111111';

      it('replay del mismo usuario: devuelve el ítem y NO vuelve a recibir la existencia inicial', async () => {
        findUnique
          .mockResolvedValueOnce({ createdById: 'u1' })
          .mockResolvedValueOnce({ id: ID, sku: 'FIL-001' });

        const res = await service.create({ ...dto, id: ID }, 'u1');

        expect(res).toEqual({ id: ID, sku: 'FIL-001', compatibilities: [] });
        expect(create).not.toHaveBeenCalled();
        expect(receive).not.toHaveBeenCalled();
      });

      it('id ocupado por otro usuario: 409 ID_CONFLICT', async () => {
        findUnique.mockResolvedValueOnce({ createdById: 'otro' });

        await expect(
          service.create({ ...dto, id: ID }, 'u1'),
        ).rejects.toMatchObject({
          response: { code: ERROR_CODES.ID_CONFLICT },
        });
        expect(receive).not.toHaveBeenCalled();
      });

      it('carrera sobre la PK: devuelve el ítem ganador sin recibir la existencia dos veces', async () => {
        findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ createdById: 'u1' })
          .mockResolvedValueOnce({ id: ID, sku: 'FIL-001' });
        create.mockRejectedValue(prismaError('P2002', { target: ['id'] }));

        const res = await service.create({ ...dto, id: ID }, 'u1');

        expect(res).toEqual({ id: ID, sku: 'FIL-001', compatibilities: [] });
        expect(receive).not.toHaveBeenCalled();
      });

      it('P2002 por SKU repetido NO es carrera: el 409 con el código de siempre', async () => {
        findUnique.mockResolvedValue(null);
        create.mockRejectedValue(prismaError('P2002', { target: ['sku'] }));

        await expect(service.create({ ...dto, id: ID }, 'u1')).rejects.toThrow(
          /FIL-001/,
        );
      });

      it('crea con el id del cliente y el dueño', async () => {
        findUnique.mockResolvedValue(null);
        create.mockResolvedValue({ id: ID });
        findUniqueOrThrow.mockResolvedValue({ id: ID });

        await service.create({ ...dto, id: ID }, 'u1');

        const [{ data }] = create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ];
        expect(data).toMatchObject({ id: ID, createdById: 'u1' });
      });
    });

    it('no registra movimiento si el ítem nace en cero', async () => {
      create.mockResolvedValue({ id: 'i1' });
      findUniqueOrThrow.mockResolvedValue({ id: 'i1' });

      await service.create({ sku: 'FIL-002', name: 'Filtro de aire' }, 'u1');

      expect(receive).not.toHaveBeenCalled();
    });

    it('traduce el choque de SKU a un mensaje que nombra el código', async () => {
      create.mockRejectedValue(prismaError('P2002'));

      await expect(service.create(dto, 'u1')).rejects.toThrow(/FIL-001/);
      await expect(service.create(dto, 'u1')).rejects.toThrow(
        ConflictException,
      );
    });

    describe('SKU generado (el formulario ya no lo pide)', () => {
      const datosDe = (n: number) =>
        (create.mock.calls[n] as [{ data: Record<string, unknown> }])[0].data;

      it('sin SKU, toma el siguiente número del prefijo (SUM- para suministros)', async () => {
        findMany.mockResolvedValueOnce([
          { sku: 'SUM-0001' },
          { sku: 'SUM-0002' },
          { sku: 'SUM-ABC' },
        ]);
        create.mockResolvedValue({ id: 'i1' });
        findUniqueOrThrow.mockResolvedValue({ id: 'i1' });

        await service.create({ name: 'AdBlue' }, 'u1');

        expect(findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { sku: { startsWith: 'SUM-' } } }),
        );
        expect(datosDe(0).sku).toBe('SUM-0003');
      });

      it('un repuesto usa REP-', async () => {
        findMany.mockResolvedValueOnce([]);
        create.mockResolvedValue({ id: 'i1' });
        findUniqueOrThrow.mockResolvedValue({ id: 'i1' });

        await service.create({ name: 'Filtro', type: ItemType.PART }, 'u1');

        expect(datosDe(0).sku).toBe('REP-0001');
      });

      it('si otra alta tomó el mismo número, reintenta con el siguiente', async () => {
        findMany
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ sku: 'SUM-0001' }]);
        create
          .mockRejectedValueOnce(prismaError('P2002'))
          .mockResolvedValueOnce({ id: 'i1' });
        findUniqueOrThrow.mockResolvedValue({ id: 'i1' });

        await service.create({ name: 'AdBlue' }, 'u1');

        expect(create).toHaveBeenCalledTimes(2);
        expect(datosDe(1).sku).toBe('SUM-0002');
      });
    });

    describe('contenido por unidad', () => {
      const datos = () =>
        (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;

      it('en unidades se guarda (bidón de 10 L); sin unidad del contenido, litros', async () => {
        create.mockResolvedValue({ id: 'i1' });
        findUniqueOrThrow.mockResolvedValue({ id: 'i1' });

        await service.create(
          {
            sku: 'ADB-10',
            name: 'AdBlue bidón',
            unit: UnitOfMeasure.UNIT,
            contentPerUnit: 10,
          },
          'u1',
        );

        expect(datos()).toMatchObject({
          contentPerUnit: 10,
          contentUnit: UnitOfMeasure.LITER,
        });
      });

      it('en litros no aplica: se guarda vacío', async () => {
        create.mockResolvedValue({ id: 'i1' });
        findUniqueOrThrow.mockResolvedValue({ id: 'i1' });

        await service.create(
          {
            sku: 'ADB-L',
            name: 'AdBlue granel',
            unit: UnitOfMeasure.LITER,
            contentPerUnit: 10,
          },
          'u1',
        );

        expect(datos()).toMatchObject({
          contentPerUnit: null,
          contentUnit: null,
        });
      });
    });

    it('explica que la categoría no existe cuando falla la FK', async () => {
      create.mockRejectedValue(prismaError('P2003'));

      await expect(service.create(dto, 'u1')).rejects.toThrow(
        /categoría indicada no existe/,
      );
    });
  });

  describe('update', () => {
    it('deja desvincular la categoría mandando null', async () => {
      // Reclasificar y limpiar son cosas distintas: omitir el campo significa
      // "no lo toques", así que sacar una categoría mal puesta necesita `null`.
      findUnique.mockResolvedValue({ id: 'i1', sku: 'FIL-001' });
      update.mockResolvedValue({ id: 'i1', categoryId: null });

      await service.update('i1', { categoryId: null });

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'i1' },
          data: { categoryId: null },
        }),
      );
    });

    it('falla si el ítem no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.update('nope', { name: 'X' })).rejects.toThrow(
        NotFoundException,
      );
    });

    describe('X-Expected', () => {
      beforeEach(() => {
        queryRaw.mockResolvedValue([{ id: 'i1' }]);
      });

      it('si otro cambió el nombre mientras tanto: 409 STALE_UPDATE y no escribe', async () => {
        findUnique
          .mockResolvedValueOnce({ id: 'i1' })
          .mockResolvedValueOnce({ name: 'Otro', isActive: true });

        await expect(
          service.update('i1', { name: 'Nuevo' }, { name: 'Viejo' }),
        ).rejects.toMatchObject({
          response: { code: ERROR_CODES.STALE_UPDATE },
        });
        expect(update).not.toHaveBeenCalled();
      });

      it('con la base vigente escribe bajo bloqueo', async () => {
        findUnique
          .mockResolvedValueOnce({ id: 'i1' })
          .mockResolvedValueOnce({ name: 'Viejo', isActive: true });
        update.mockResolvedValue({ id: 'i1' });

        await service.update('i1', { name: 'Nuevo' }, { name: 'Viejo' });

        expect(queryRaw).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('adjust (conteo físico)', () => {
    const ID = '11111111-1111-4111-8111-111111111111';
    const dto = { id: ID, branchId: 'b1', countedQuantity: 20 };
    const movement = {
      id: ID,
      itemId: 'i1',
      reason: MovementReason.PHYSICAL_ADJUSTMENT,
      performedById: 'u1',
    };

    it('replay del mismo usuario: devuelve ítem y asiento sin volver a contar', async () => {
      movementFindUnique.mockResolvedValue(movement);
      findUnique.mockResolvedValue({ id: 'i1' });

      const res = await service.adjust('i1', dto, 'u1');

      expect(res.movement).toBe(movement);
      expect(adjustToCount).not.toHaveBeenCalled();
    });

    it('id ocupado por otro usuario: 409 ID_CONFLICT', async () => {
      movementFindUnique.mockResolvedValue({
        ...movement,
        performedById: 'otro',
      });

      await expect(service.adjust('i1', dto, 'u1')).rejects.toMatchObject({
        response: { code: ERROR_CODES.ID_CONFLICT },
      });
      expect(adjustToCount).not.toHaveBeenCalled();
    });

    it('un id que es de otro ítem o de otro tipo de asiento: 409 ID_CONFLICT', async () => {
      movementFindUnique.mockResolvedValue({
        ...movement,
        itemId: 'otro_item',
      });

      await expect(service.adjust('i1', dto, 'u1')).rejects.toMatchObject({
        response: { code: ERROR_CODES.ID_CONFLICT },
      });
    });

    it('pasa id, expectedQuantity y dueño al conteo', async () => {
      movementFindUnique.mockResolvedValue(null);
      findUnique.mockResolvedValue({ id: 'i1' });
      adjustToCount.mockResolvedValue(movement);

      await service.adjust('i1', { ...dto, expectedQuantity: 30 }, 'u1');

      expect(adjustToCount).toHaveBeenCalledWith(
        expect.objectContaining({
          id: ID,
          itemId: 'i1',
          expectedQuantity: 30,
          performedById: 'u1',
        }),
      );
    });

    it('el perdedor de una carrera con el mismo id (ve diferencia 0 tras el bloqueo) devuelve el asiento de la ganadora, no movement null', async () => {
      movementFindUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(movement);
      findUnique.mockResolvedValue({ id: 'i1' });
      adjustToCount.mockResolvedValue(null);

      const res = await service.adjust('i1', dto, 'u1');

      expect(res.movement).toBe(movement);
    });

    it('si la que ganó la carrera con ese id es de otro usuario: 409 ID_CONFLICT', async () => {
      movementFindUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...movement, performedById: 'otro' });
      findUnique.mockResolvedValue({ id: 'i1' });
      adjustToCount.mockResolvedValue(null);

      await expect(service.adjust('i1', dto, 'u1')).rejects.toMatchObject({
        response: { code: ERROR_CODES.ID_CONFLICT },
      });
    });

    it('un conteo que coincide no deja asiento (movement null)', async () => {
      movementFindUnique.mockResolvedValue(null);
      findUnique.mockResolvedValue({ id: 'i1' });
      adjustToCount.mockResolvedValue(null);

      const res = await service.adjust('i1', dto, 'u1');

      expect(res.movement).toBeNull();
    });
  });

  describe('equipos asignados', () => {
    it('findAll aplana los equipos y filtra por equipmentId en una sola consulta', async () => {
      findMany.mockResolvedValue([
        {
          id: 'i1',
          compatibilities: [
            {
              equipmentId: 'e1',
              note: 'solo serie 4500',
              equipment: { internalCode: 'EXC-01' },
            },
          ],
        },
      ]);

      const res = await service.findAll({ equipmentId: 'e1' });

      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { compatibilities: { some: { equipmentId: 'e1' } } },
        }),
      );
      expect(res[0].compatibilities).toEqual([
        { equipmentId: 'e1', internalCode: 'EXC-01', note: 'solo serie 4500' },
      ]);
    });

    describe('setCompatibilities', () => {
      beforeEach(() => {
        findUnique.mockResolvedValue({ id: 'i1', compatibilities: [] });
        compatFindMany.mockResolvedValue([
          {
            equipmentId: 'e1',
            note: null,
            equipment: { internalCode: 'EXC-01' },
          },
        ]);
      });

      it('borra los que ya no están y crea o actualiza el resto', async () => {
        equipmentFindMany.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }]);

        const res = await service.setCompatibilities(
          'i1',
          {
            entries: [
              { equipmentId: 'e1', note: ' con adaptador ' },
              { equipmentId: 'e2' },
            ],
          },
          'u1',
        );

        expect(compatDeleteMany).toHaveBeenCalledWith({
          where: { itemId: 'i1', equipmentId: { notIn: ['e1', 'e2'] } },
        });
        expect(compatUpsert).toHaveBeenCalledTimes(2);
        expect(compatUpsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { equipmentId_itemId: { equipmentId: 'e2', itemId: 'i1' } },
            create: {
              equipmentId: 'e2',
              itemId: 'i1',
              note: null,
              declaredById: 'u1',
            },
          }),
        );
        expect(res).toEqual([
          { equipmentId: 'e1', internalCode: 'EXC-01', note: null },
        ]);
      });

      it('un equipo repetido cuenta una vez', async () => {
        equipmentFindMany.mockResolvedValue([{ id: 'e1' }]);

        await service.setCompatibilities(
          'i1',
          {
            entries: [
              { equipmentId: 'e1', note: 'a' },
              { equipmentId: 'e1', note: 'b' },
            ],
          },
          'u1',
        );

        expect(compatUpsert).toHaveBeenCalledTimes(1);
        expect(compatUpsert).toHaveBeenCalledWith(
          expect.objectContaining({ update: { note: 'b' } }),
        );
      });

      it('con una lista vacía deja al ítem sin equipos', async () => {
        equipmentFindMany.mockResolvedValue([]);

        await service.setCompatibilities('i1', { entries: [] }, 'u1');

        expect(compatDeleteMany).toHaveBeenCalledWith({
          where: { itemId: 'i1', equipmentId: { notIn: [] } },
        });
        expect(compatUpsert).not.toHaveBeenCalled();
      });

      it('404 si un equipo no existe, sin escribir nada', async () => {
        equipmentFindMany.mockResolvedValue([{ id: 'e1' }]);

        await expect(
          service.setCompatibilities(
            'i1',
            { entries: [{ equipmentId: 'e1' }, { equipmentId: 'ghost' }] },
            'u1',
          ),
        ).rejects.toThrow(/ghost/);
        expect(compatDeleteMany).not.toHaveBeenCalled();
        expect(compatUpsert).not.toHaveBeenCalled();
      });

      it('404 si el ítem no existe', async () => {
        findUnique.mockResolvedValue(null);
        await expect(
          service.setCompatibilities('nope', { entries: [] }, 'u1'),
        ).rejects.toThrow(NotFoundException);
      });
    });

    describe('consumers', () => {
      it('agrega las salidas por equipo, la más reciente primero', async () => {
        findUnique.mockResolvedValue({ id: 'i1', compatibilities: [] });
        movementGroupBy.mockResolvedValue([
          {
            equipmentId: 'e1',
            _sum: { quantity: 12 },
            _count: { _all: 3 },
            _max: { occurredAt: new Date('2026-10-01T00:00:00Z') },
          },
          {
            equipmentId: 'e2',
            _sum: { quantity: 4 },
            _count: { _all: 1 },
            _max: { occurredAt: new Date('2026-11-01T00:00:00Z') },
          },
        ]);
        equipmentFindMany.mockResolvedValue([
          { id: 'e1', internalCode: 'EXC-01' },
          { id: 'e2', internalCode: 'CAM-02' },
        ]);

        const res = await service.consumers('i1');

        expect(movementGroupBy).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              itemId: 'i1',
              direction: 'OUT',
              equipmentId: { not: null },
            },
          }),
        );
        expect(res.map((r) => r.internalCode)).toEqual(['CAM-02', 'EXC-01']);
        expect(res[1]).toMatchObject({
          totalQuantity: 12,
          movementCount: 3,
        });
      });

      it('sin salidas imputadas devuelve una lista vacía', async () => {
        findUnique.mockResolvedValue({ id: 'i1', compatibilities: [] });
        movementGroupBy.mockResolvedValue([]);
        equipmentFindMany.mockResolvedValue([]);
        expect(await service.consumers('i1')).toEqual([]);
      });
    });
  });

  describe('setActive', () => {
    it('da de baja sin tocar el kardex', async () => {
      findUnique.mockResolvedValue({ id: 'i1', sku: 'FIL-001' });
      update.mockResolvedValue({ id: 'i1', isActive: false });

      await service.setActive('i1', false);

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'i1' },
          data: { isActive: false },
        }),
      );
    });

    it('falla si el ítem no existe', async () => {
      findUnique.mockResolvedValue(null);
      await expect(service.setActive('nope', false)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('bloquea el borrado de un ítem con kardex y sugiere la baja lógica', async () => {
      // `onDelete: Cascade` en los movimientos: borrarlo se llevaría el
      // historial por delante sin avisar.
      findUnique.mockResolvedValue({
        id: 'i1',
        sku: 'FIL-001',
        _count: { movements: 7 },
      });

      await expect(service.remove('i1')).rejects.toThrow(/Dalo de baja/);
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('borra el ítem que nunca se movió', async () => {
      findUnique.mockResolvedValue({
        id: 'i1',
        sku: 'FIL-001',
        _count: { movements: 0 },
      });

      await service.remove('i1');

      expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'i1' } });
    });
  });

  describe('findAll', () => {
    it('busca el texto libre en sku, nombre y número de parte', async () => {
      // El mecánico lee el número de parte en la pieza, no nuestro SKU: si la
      // búsqueda no lo cubriera, tendría que adivinar el código interno.
      findMany.mockResolvedValue([]);

      await service.findAll({ q: '1R-0750', type: 'PART' });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { sku: { contains: '1R-0750', mode: 'insensitive' } },
              { name: { contains: '1R-0750', mode: 'insensitive' } },
              { partNumber: { contains: '1R-0750', mode: 'insensitive' } },
            ],
            type: 'PART',
          },
        }),
      );
    });
  });
});

describe('UpdateItemDto', () => {
  it('acepta categoryId en null y rechaza otros tipos', async () => {
    const limpiar = plainToInstance(UpdateItemDto, { categoryId: null });
    const invalido = plainToInstance(UpdateItemDto, { categoryId: 42 });

    expect(await validate(limpiar)).toHaveLength(0);
    expect(await validate(invalido)).not.toHaveLength(0);
  });
});
