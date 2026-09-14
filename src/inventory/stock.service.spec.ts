import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { MovementDirection, MovementReason } from '@prisma/client';

import { DOMAIN_EVENTS } from '../common/events/domain-events';
import { PrismaService } from '../common/prisma/prisma.service';
import { StockService } from './stock.service';

const ITEM = { id: 'item_1', name: 'Aceite motor 15W-40' };
const BRANCH = { id: 'branch_1', name: 'Rajo Norte', isActive: true };

describe('StockService', () => {
  let service: StockService;

  const itemFindUnique = jest.fn();
  const branchFindUnique = jest.fn();
  const stockUpsert = jest.fn();
  const stockUpdateMany = jest.fn();
  const stockFindUnique = jest.fn();
  const stockAggregate = jest.fn();
  const movementCreate = jest.fn();
  const emit = jest.fn();

  beforeEach(async () => {
    for (const mock of [
      itemFindUnique,
      branchFindUnique,
      stockUpsert,
      stockUpdateMany,
      stockFindUnique,
      stockAggregate,
      movementCreate,
      emit,
    ]) {
      mock.mockReset();
    }

    itemFindUnique.mockResolvedValue(ITEM);
    branchFindUnique.mockResolvedValue(BRANCH);
    stockAggregate.mockResolvedValue({ _sum: { quantity: 0 } });
    movementCreate.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve(data),
    );

    const prismaMock = {
      inventoryItem: { findUnique: itemFindUnique },
      branch: { findUnique: branchFindUnique },
      stock: {
        upsert: stockUpsert,
        updateMany: stockUpdateMany,
        findUnique: stockFindUnique,
        aggregate: stockAggregate,
      },
      stockMovement: { create: movementCreate },
      // `run` abre una transacción cuando el llamador no pasa `tx`: el mock
      // ejecuta el callback con el mismo cliente, que es lo que hace Prisma de
      // verdad salvo por el aislamiento.
      $transaction: (fn: (tx: unknown) => unknown) => fn(prismaMock),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StockService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();

    service = module.get<StockService>(StockService);
  });

  describe('issue', () => {
    it('descuenta de la bodega y guarda SU saldo en el asiento', async () => {
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ quantity: 70, minimumQuantity: 0 });

      const movement = await service.issue({
        itemId: 'item_1',
        branchId: 'branch_1',
        quantity: 30,
        reason: MovementReason.INTERVENTION,
        performedById: 'user_1',
        reference: 'interv_1',
      });

      expect(movement).toMatchObject({
        itemId: 'item_1',
        branchId: 'branch_1',
        direction: MovementDirection.OUT,
        reason: MovementReason.INTERVENTION,
        quantity: 30,
        // El saldo de LA BODEGA: es el número que el kardex de esa sucursal
        // puede auditar renglón a renglón.
        resultingBalance: 70,
        performedById: 'user_1',
        reference: 'interv_1',
      });
    });

    it('descuenta con la condición de saldo en el propio WHERE', async () => {
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ quantity: 90, minimumQuantity: 0 });

      await service.issue({
        itemId: 'item_1',
        branchId: 'branch_1',
        quantity: 10,
        reason: MovementReason.ACTIVITY,
      });

      // Es la garantía contra dos salidas concurrentes dejando saldo negativo:
      // Postgres decide y aplica en una sola sentencia.
      expect(stockUpdateMany).toHaveBeenCalledWith({
        where: {
          itemId: 'item_1',
          branchId: 'branch_1',
          quantity: { gte: 10 },
        },
        data: { quantity: { decrement: 10 } },
      });
    });

    it('rechaza mover existencias en una sucursal desactivada', async () => {
      branchFindUnique.mockResolvedValue({ ...BRANCH, isActive: false });

      await expect(
        service.issue({
          itemId: 'item_1',
          branchId: 'branch_1',
          quantity: 10,
          reason: MovementReason.INTERVENTION,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('lanza ConflictException y no registra asiento si el saldo no alcanza', async () => {
      stockUpdateMany.mockResolvedValue({ count: 0 });
      stockFindUnique.mockResolvedValue({ quantity: 5 });

      await expect(
        service.issue({
          itemId: 'item_1',
          branchId: 'branch_1',
          quantity: 30,
          reason: MovementReason.INTERVENTION,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(movementCreate).not.toHaveBeenCalled();
    });

    it('avisa cuándo el ítem sí existe en otra bodega', async () => {
      stockUpdateMany.mockResolvedValue({ count: 0 });
      stockFindUnique.mockResolvedValue({ quantity: 5 });
      stockAggregate.mockResolvedValue({ _sum: { quantity: 100 } });

      // La diferencia entre "hay que comprar" y "hay que traerlo de Rajo Sur"
      // es la decisión completa del bodeguero.
      await expect(
        service.issue({
          itemId: 'item_1',
          branchId: 'branch_1',
          quantity: 30,
          reason: MovementReason.INTERVENTION,
        }),
      ).rejects.toThrow(/95 en otras sucursales/);
    });

    it('lanza NotFoundException cuando el ítem no existe', async () => {
      stockUpdateMany.mockResolvedValue({ count: 0 });
      itemFindUnique.mockResolvedValue(null);

      await expect(
        service.issue({
          itemId: 'missing',
          branchId: 'branch_1',
          quantity: 1,
          reason: MovementReason.INTERVENTION,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rechaza cantidades no positivas', async () => {
      await expect(
        service.issue({
          itemId: 'item_1',
          branchId: 'branch_1',
          quantity: 0,
          reason: MovementReason.INTERVENTION,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('alerta de mínimo', () => {
    it('emite al CRUZAR el mínimo de la bodega hacia abajo', async () => {
      // Queda en 4 tras una salida de 6: antes estaba en 10, sobre el mínimo 5.
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ quantity: 4, minimumQuantity: 5 });

      await service.issue({
        itemId: 'item_1',
        branchId: 'branch_1',
        quantity: 6,
        reason: MovementReason.INTERVENTION,
      });

      expect(emit).toHaveBeenCalledWith(DOMAIN_EVENTS.ITEM_LOW_STOCK, {
        itemId: 'item_1',
        itemName: 'Aceite motor 15W-40',
        branchId: 'branch_1',
        branchName: 'Rajo Norte',
        quantity: 4,
        minimumQuantity: 5,
      });
    });

    it('NO reemite si la bodega ya estaba bajo el mínimo', async () => {
      // Queda en 3 tras una salida de 1: antes estaba en 4, ya bajo el mínimo.
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ quantity: 3, minimumQuantity: 5 });

      await service.issue({
        itemId: 'item_1',
        branchId: 'branch_1',
        quantity: 1,
        reason: MovementReason.INTERVENTION,
      });

      // Si no, la primera mantención larga llena el centro de notificaciones y
      // se dejan de leer.
      expect(emit).not.toHaveBeenCalled();
    });

    it('NO alerta si la bodega no fijó un mínimo propio', async () => {
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ quantity: 0, minimumQuantity: 0 });

      await service.issue({
        itemId: 'item_1',
        branchId: 'branch_1',
        quantity: 5,
        reason: MovementReason.INTERVENTION,
      });

      // `minimumQuantity = 0` es "no configurado". Heredar el umbral de la
      // empresa encendería la alerta en todas las filas a la vez.
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('receive', () => {
    it('crea la fila de saldo si la bodega nunca tuvo el ítem', async () => {
      stockUpsert.mockResolvedValue({ quantity: 50 });

      const movement = await service.receive({
        itemId: 'item_1',
        branchId: 'branch_1',
        quantity: 50,
        reason: MovementReason.PURCHASE,
      });

      expect(stockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            itemId_branchId: { itemId: 'item_1', branchId: 'branch_1' },
          },
          create: { itemId: 'item_1', branchId: 'branch_1', quantity: 50 },
          update: { quantity: { increment: 50 } },
        }),
      );
      expect(movement).toMatchObject({
        direction: MovementDirection.IN,
        quantity: 50,
        resultingBalance: 50,
      });
    });
  });

  describe('adjustToCount', () => {
    it('compara contra el saldo de LA BODEGA, no contra el total', async () => {
      stockFindUnique.mockResolvedValue({ quantity: 30 });
      stockUpsert.mockResolvedValue({ quantity: 45 });

      const movement = await service.adjustToCount({
        itemId: 'item_1',
        branchId: 'branch_1',
        countedQuantity: 45,
      });

      expect(movement).toMatchObject({
        direction: MovementDirection.IN,
        reason: MovementReason.PHYSICAL_ADJUSTMENT,
        quantity: 15,
      });
    });

    it('registra una salida cuando el conteo es menor', async () => {
      stockFindUnique.mockResolvedValue({ quantity: 30, minimumQuantity: 0 });
      stockUpdateMany.mockResolvedValue({ count: 1 });

      const movement = await service.adjustToCount({
        itemId: 'item_1',
        branchId: 'branch_1',
        countedQuantity: 20,
      });

      expect(movement).toMatchObject({
        direction: MovementDirection.OUT,
        reason: MovementReason.PHYSICAL_ADJUSTMENT,
        quantity: 10,
      });
    });

    it('no registra asiento si el conteo coincide', async () => {
      stockFindUnique.mockResolvedValue({ quantity: 30 });

      const movement = await service.adjustToCount({
        itemId: 'item_1',
        branchId: 'branch_1',
        countedQuantity: 30,
      });

      expect(movement).toBeNull();
      expect(movementCreate).not.toHaveBeenCalled();
    });
  });

  it('reutiliza la transacción del llamador cuando se le pasa un tx', async () => {
    const txUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txFindUnique = jest
      .fn()
      .mockResolvedValue({ quantity: 90, minimumQuantity: 0 });
    const txCreate = jest.fn().mockResolvedValue({});
    const tx = {
      inventoryItem: { findUnique: jest.fn().mockResolvedValue(ITEM) },
      branch: { findUnique: jest.fn().mockResolvedValue(BRANCH) },
      stock: { updateMany: txUpdateMany, findUnique: txFindUnique },
      stockMovement: { create: txCreate },
    };

    await service.issue(
      {
        itemId: 'item_1',
        branchId: 'branch_1',
        quantity: 10,
        reason: MovementReason.INTERVENTION,
      },
      tx as never,
    );

    // Todo pasó por el tx del llamador — si no, el descuento quedaría fuera de
    // su transacción y un rollback suyo no lo revertiría.
    expect(txUpdateMany).toHaveBeenCalled();
    expect(txCreate).toHaveBeenCalled();
    expect(stockUpdateMany).not.toHaveBeenCalled();
    expect(movementCreate).not.toHaveBeenCalled();
  });
});
