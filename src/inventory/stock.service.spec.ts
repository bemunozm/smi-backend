import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { MovementDirection, MovementReason } from '@prisma/client';

import { ERROR_CODES } from '../common/errors/error-codes';
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
  const movementUpdate = jest.fn();
  const movementFindUnique = jest.fn();
  const movementFindFirstOrThrow = jest.fn();
  const branchFindMany = jest.fn();
  const queryRaw = jest.fn();
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
      movementUpdate,
      movementFindUnique,
      movementFindFirstOrThrow,
      branchFindMany,
      queryRaw,
      emit,
    ]) {
      mock.mockReset();
    }

    itemFindUnique.mockResolvedValue(ITEM);
    movementUpdate.mockResolvedValue({});
    branchFindUnique.mockResolvedValue(BRANCH);
    stockAggregate.mockResolvedValue({ _sum: { quantity: 0 } });
    movementCreate.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve(data),
    );

    const prismaMock = {
      inventoryItem: { findUnique: itemFindUnique },
      branch: { findUnique: branchFindUnique, findMany: branchFindMany },
      stock: {
        upsert: stockUpsert,
        updateMany: stockUpdateMany,
        findUnique: stockFindUnique,
        aggregate: stockAggregate,
      },
      stockMovement: {
        create: movementCreate,
        update: movementUpdate,
        findUnique: movementFindUnique,
        findFirstOrThrow: movementFindFirstOrThrow,
      },
      // Bloqueo y lectura del saldo de la bodega (`FOR UPDATE`) en el conteo.
      $queryRaw: queryRaw,
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
      stockFindUnique.mockResolvedValue({ id: 'stock_1' });
      queryRaw.mockResolvedValue([{ quantity: 30 }]);
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
      stockFindUnique
        .mockResolvedValueOnce({ id: 'stock_1' })
        .mockResolvedValue({ quantity: 20, minimumQuantity: 0 });
      queryRaw.mockResolvedValue([{ quantity: 30 }]);
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
      stockFindUnique.mockResolvedValue({ id: 'stock_1' });
      queryRaw.mockResolvedValue([{ quantity: 30 }]);

      const movement = await service.adjustToCount({
        itemId: 'item_1',
        branchId: 'branch_1',
        countedQuantity: 30,
      });

      expect(movement).toBeNull();
      expect(movementCreate).not.toHaveBeenCalled();
    });
  });

  describe('setMinimum', () => {
    it('crea la fila de saldo si la bodega todavía no maneja el ítem', async () => {
      stockUpsert.mockResolvedValue({
        itemId: 'item_1',
        branchId: 'branch_1',
        minimumQuantity: 5,
      });

      await service.setMinimum({
        itemId: 'item_1',
        branchId: 'branch_1',
        minimumQuantity: 5,
      });

      // Configurar el mínimo ANTES de que llegue el primer material es el caso
      // normal, no la excepción.
      expect(stockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: {
            itemId: 'item_1',
            branchId: 'branch_1',
            quantity: 0,
            minimumQuantity: 5,
          },
          update: { minimumQuantity: 5 },
        }),
      );
    });
  });

  describe('transfer', () => {
    const DESTINATION = { id: 'branch_2', name: 'Faena', isActive: true };

    function mockTransferOk() {
      branchFindUnique.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve(where.id === 'branch_2' ? DESTINATION : BRANCH),
      );
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ quantity: 40, minimumQuantity: 0 });
      stockUpsert.mockResolvedValue({ quantity: 10 });
      movementCreate.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: `mov_${String(data.direction)}`, ...data }),
      );
    }

    it('registra DOS asientos con el mismo reference y reason TRANSFER', async () => {
      mockTransferOk();

      const result = await service.transfer(
        {
          itemId: 'item_1',
          sourceBranchId: 'branch_1',
          destinationBranchId: 'branch_2',
          quantity: 10,
        },
        'user_1',
      );

      // El saldo de cada bodega se deriva leyendo
      // solo sus propios asientos, sin interpretar el signo según de qué lado
      // se mire.
      expect(result.out).toMatchObject({
        branchId: 'branch_1',
        direction: MovementDirection.OUT,
        reason: MovementReason.TRANSFER,
        reference: result.reference,
      });
      expect(result.in).toMatchObject({
        branchId: 'branch_2',
        direction: MovementDirection.IN,
        reason: MovementReason.TRANSFER,
        reference: result.reference,
      });
    });

    it('deja la guía de despacho en los dos asientos, sin pisar el folio', async () => {
      // Son dos campos distintos a propósito: `reference` es el vínculo interno
      // que aparea los asientos, y `documentNumber` es el papel que viaja con
      // el material. Si compartieran campo, un traspaso no podría tener ambos.
      mockTransferOk();

      const result = await service.transfer(
        {
          itemId: 'item_1',
          sourceBranchId: 'branch_1',
          destinationBranchId: 'branch_2',
          quantity: 10,
          documentNumber: 'GD-4471',
        },
        'user_1',
      );

      expect(result.out).toMatchObject({ documentNumber: 'GD-4471' });
      expect(result.in).toMatchObject({ documentNumber: 'GD-4471' });
      expect(result.reference).not.toBe('GD-4471');
    });

    it('rechaza traspasar a la misma sucursal', async () => {
      await expect(
        service.transfer(
          {
            itemId: 'item_1',
            sourceBranchId: 'branch_1',
            destinationBranchId: 'branch_1',
            quantity: 10,
          },
          'user_1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('no escribe nada si el origen no alcanza', async () => {
      branchFindUnique.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve(where.id === 'branch_2' ? DESTINATION : BRANCH),
      );
      stockUpdateMany.mockResolvedValue({ count: 0 });
      stockFindUnique.mockResolvedValue({ quantity: 2 });

      // El peor resultado posible de un traspaso es que la existencia salga de
      // una bodega y no llegue a la otra. Los dos asientos van en la misma
      // transacción justamente para que eso no pueda pasar.
      await expect(
        service.transfer(
          {
            itemId: 'item_1',
            sourceBranchId: 'branch_1',
            destinationBranchId: 'branch_2',
            quantity: 10,
          },
          'user_1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      // La fila vacía del destino solo existe para bloquearla; la entrada nunca
      // llegó a acreditarse.
      expect(stockUpsert).not.toHaveBeenCalledWith(
        expect.objectContaining({
          update: { quantity: { increment: 10 } },
        }),
      );
      expect(movementCreate).not.toHaveBeenCalled();
    });

    describe('bloqueo de las filas de saldo', () => {
      /** Las `branchId` bloqueadas con `FOR UPDATE`, en el orden en que se pidieron. */
      function lockedBranchIds(): string[] {
        return queryRaw.mock.calls.map((call: unknown[]) => call[2] as string);
      }

      const transferOf = (
        sourceBranchId: string,
        destinationBranchId: string,
      ) =>
        service.transfer(
          {
            itemId: 'item_1',
            sourceBranchId,
            destinationBranchId,
            quantity: 10,
          },
          'user_1',
        );

      it('bloquea las dos filas en orden por branchId, sin importar la dirección', async () => {
        mockTransferOk();

        await transferOf('branch_1', 'branch_2');
        const ida = lockedBranchIds();
        queryRaw.mockClear();
        await transferOf('branch_2', 'branch_1');
        const vuelta = lockedBranchIds();

        // A→B y B→A piden las filas en el mismo orden: no pueden esperarse
        // mutuamente (deadlock).
        expect(ida).toEqual(['branch_1', 'branch_2']);
        expect(vuelta).toEqual(['branch_1', 'branch_2']);
      });

      it('bloquea ANTES de mover el saldo', async () => {
        mockTransferOk();
        const orden: string[] = [];
        queryRaw.mockImplementation(() => {
          orden.push('lock');
          return Promise.resolve([]);
        });
        stockUpdateMany.mockImplementation(() => {
          orden.push('descuento');
          return Promise.resolve({ count: 1 });
        });

        await transferOf('branch_1', 'branch_2');

        expect(orden).toEqual(['lock', 'lock', 'descuento']);
      });

      it('crea vacía solo la fila del destino para poder bloquearla', async () => {
        mockTransferOk();

        await transferOf('branch_2', 'branch_1');

        const llamadas = stockUpsert.mock.calls as [
          { create: { itemId: string; branchId: string; quantity: number } },
        ][];
        const vacias = llamadas
          .map(([args]) => args)
          .filter((args) => args.create.quantity === 0);
        expect(vacias).toHaveLength(1);
        expect(vacias[0]).toMatchObject({
          create: { itemId: 'item_1', branchId: 'branch_1', quantity: 0 },
        });
      });
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
      { tx: tx as never, events: [] },
    );

    // Todo pasó por el tx del llamador — si no, el descuento quedaría fuera de
    // su transacción y un rollback suyo no lo revertiría.
    expect(txUpdateMany).toHaveBeenCalled();
    expect(txCreate).toHaveBeenCalled();
    expect(stockUpdateMany).not.toHaveBeenCalled();
    expect(movementCreate).not.toHaveBeenCalled();
  });

  describe('existencia insuficiente', () => {
    it('responde 409 con code INSUFFICIENT_STOCK y el mensaje claro', async () => {
      stockUpdateMany.mockResolvedValue({ count: 0 });
      stockFindUnique.mockResolvedValue({ quantity: 2 });

      const error = await service
        .issue({
          itemId: 'item_1',
          branchId: 'branch_1',
          quantity: 10,
          reason: MovementReason.INTERVENTION,
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: ERROR_CODES.INSUFFICIENT_STOCK,
      });
      expect((error as ConflictException).message).toContain(
        'Existencia insuficiente',
      );
    });
  });

  describe('cantidades en los mensajes', () => {
    it('la existencia insuficiente se lee con coma decimal y separador de miles', async () => {
      stockUpdateMany.mockResolvedValue({ count: 0 });
      stockFindUnique.mockResolvedValue({ quantity: 1234.5 });
      stockAggregate.mockResolvedValue({ _sum: { quantity: 3234.5 } });

      const error = await service
        .issue({
          itemId: 'item_1',
          branchId: 'branch_1',
          quantity: 2000.75,
          reason: MovementReason.INTERVENTION,
        })
        .catch((e: unknown) => e);

      expect((error as ConflictException).message).toContain(
        'disponible 1.234,5, solicitado 2.000,75. Hay 2.000 en otras sucursales.',
      );
    });
  });

  describe('id del cliente en el asiento', () => {
    it('el asiento nace con el id que mandó el cliente', async () => {
      stockUpsert.mockResolvedValue({ quantity: 50 });

      await service.receive({
        id: 'mov-client-1',
        itemId: 'item_1',
        branchId: 'branch_1',
        quantity: 50,
        reason: MovementReason.PURCHASE,
      });

      const [{ data }] = movementCreate.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toMatchObject({ id: 'mov-client-1' });
    });
  });

  describe('aviso de existencia baja: solo tras confirmar', () => {
    function crossMinimum() {
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ quantity: 4, minimumQuantity: 5 });
    }

    it('al confirmar la transacción se emite el aviso una sola vez', async () => {
      crossMinimum();

      await service.issue({
        itemId: 'item_1',
        branchId: 'branch_1',
        quantity: 6,
        reason: MovementReason.INTERVENTION,
      });

      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('si la transacción falla después de cruzar el mínimo, no se emite nada', async () => {
      crossMinimum();
      movementCreate.mockRejectedValue(new Error('boom'));

      await expect(
        service.issue({
          itemId: 'item_1',
          branchId: 'branch_1',
          quantity: 6,
          reason: MovementReason.INTERVENTION,
        }),
      ).rejects.toThrow('boom');

      expect(emit).not.toHaveBeenCalled();
    });

    it('en un traspaso, si la entrada falla tras la salida que cruzó el mínimo, no se emite', async () => {
      crossMinimum();
      branchFindUnique.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve(
            where.id === 'branch_2'
              ? { id: 'branch_2', name: 'Faena', isActive: true }
              : BRANCH,
          ),
      );
      movementCreate.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          data.direction === MovementDirection.OUT
            ? Promise.resolve({ id: 'mov_out', ...data })
            : Promise.reject(new Error('falla la entrada')),
      );
      stockUpsert.mockResolvedValue({ quantity: 10 });

      await expect(
        service.transfer(
          {
            itemId: 'item_1',
            sourceBranchId: 'branch_1',
            destinationBranchId: 'branch_2',
            quantity: 6,
          },
          'user_1',
        ),
      ).rejects.toThrow('falla la entrada');

      expect(emit).not.toHaveBeenCalled();
    });

    it('con la transacción de otro dominio los avisos quedan en su buzón hasta que él los emita', async () => {
      const events: Parameters<StockService['emitPending']>[0] = [];
      const tx = {
        inventoryItem: { findUnique: jest.fn().mockResolvedValue(ITEM) },
        branch: { findUnique: jest.fn().mockResolvedValue(BRANCH) },
        stock: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest
            .fn()
            .mockResolvedValue({ quantity: 4, minimumQuantity: 5 }),
        },
        stockMovement: { create: jest.fn().mockResolvedValue({}) },
      };

      await service.issue(
        {
          itemId: 'item_1',
          branchId: 'branch_1',
          quantity: 6,
          reason: MovementReason.INTERVENTION,
        },
        { tx: tx as never, events },
      );

      expect(emit).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);

      service.emitPending(events);
      expect(emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.ITEM_LOW_STOCK,
        expect.objectContaining({ itemId: 'item_1', quantity: 4 }),
      );
    });
  });

  describe('conteo físico con expectedQuantity', () => {
    beforeEach(() => {
      stockFindUnique.mockResolvedValue({ id: 'stock_1' });
    });

    it('si alguien movió stock mientras se contaba: 409 STALE_UPDATE y no registra asiento', async () => {
      queryRaw.mockResolvedValue([{ quantity: 25 }]);

      await expect(
        service.adjustToCount({
          itemId: 'item_1',
          branchId: 'branch_1',
          countedQuantity: 20,
          expectedQuantity: 30,
        }),
      ).rejects.toMatchObject({
        response: { code: ERROR_CODES.STALE_UPDATE },
      });
      expect(movementCreate).not.toHaveBeenCalled();
    });

    it('pasa si la existencia sigue como el usuario la vio', async () => {
      queryRaw.mockResolvedValue([{ quantity: 30 }]);
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique
        .mockResolvedValueOnce({ id: 'stock_1' })
        .mockResolvedValue({ quantity: 20, minimumQuantity: 0 });

      await expect(
        service.adjustToCount({
          itemId: 'item_1',
          branchId: 'branch_1',
          countedQuantity: 20,
          expectedQuantity: 30,
        }),
      ).resolves.toMatchObject({ quantity: 10 });
    });

    it('pasa si la existencia ya vale el conteo (el reintento de un conteo aplicado)', async () => {
      queryRaw.mockResolvedValue([{ quantity: 20 }]);

      await expect(
        service.adjustToCount({
          itemId: 'item_1',
          branchId: 'branch_1',
          countedQuantity: 20,
          expectedQuantity: 30,
        }),
      ).resolves.toBeNull();
      expect(movementCreate).not.toHaveBeenCalled();
    });

    it('sin fila de saldo y conteo en cero no crea nada', async () => {
      stockFindUnique.mockResolvedValue(null);

      await expect(
        service.adjustToCount({
          itemId: 'item_1',
          branchId: 'branch_1',
          countedQuantity: 0,
        }),
      ).resolves.toBeNull();
      expect(stockUpsert).not.toHaveBeenCalled();
    });
  });

  describe('traspaso idempotente', () => {
    const ID = '11111111-1111-4111-8111-111111111111';
    const DESTINATION = { id: 'branch_2', name: 'Faena', isActive: true };
    const input = {
      id: ID,
      itemId: 'item_1',
      sourceBranchId: 'branch_1',
      destinationBranchId: 'branch_2',
      quantity: 10,
    };

    it('con id: la salida lleva ese id y la reference es determinista', async () => {
      movementFindUnique.mockResolvedValue(null);
      branchFindUnique.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve(where.id === 'branch_2' ? DESTINATION : BRANCH),
      );
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ quantity: 40, minimumQuantity: 0 });
      stockUpsert.mockResolvedValue({ quantity: 10 });
      movementCreate.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: data.id ?? 'mov_in', ...data }),
      );

      const result = await service.transfer(input, 'user_1');

      expect(result.reference).toBe(`transfer_${ID}`);
      expect(result.out).toMatchObject({
        id: ID,
        destinationBranchId: 'branch_2',
      });
      expect(result.in).toMatchObject({ sourceBranchId: 'branch_1' });
    });

    it('replay del mismo usuario: reconstruye la respuesta sin mover saldo ni emitir', async () => {
      const out = {
        id: ID,
        branchId: 'branch_1',
        destinationBranchId: 'branch_2',
        direction: MovementDirection.OUT,
        reason: MovementReason.TRANSFER,
        reference: `transfer_${ID}`,
        performedById: 'user_1',
      };
      const incoming = { id: 'mov_in', direction: MovementDirection.IN };
      movementFindUnique.mockResolvedValue(out);
      movementFindFirstOrThrow.mockResolvedValue(incoming);
      branchFindMany.mockResolvedValue([
        { id: 'branch_1', name: 'Rajo Norte' },
        { id: 'branch_2', name: 'Faena' },
      ]);

      const result = await service.transfer(input, 'user_1');

      expect(result).toEqual({
        reference: `transfer_${ID}`,
        out,
        in: incoming,
        sourceBranchName: 'Rajo Norte',
        destinationBranchName: 'Faena',
      });
      expect(stockUpdateMany).not.toHaveBeenCalled();
      expect(movementCreate).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('la entrada del replay se identifica por ítem, destino, origen y autor, no solo por la reference', async () => {
      movementFindUnique.mockResolvedValue({
        id: ID,
        itemId: 'item_1',
        branchId: 'branch_1',
        destinationBranchId: 'branch_2',
        direction: MovementDirection.OUT,
        reason: MovementReason.TRANSFER,
        reference: `transfer_${ID}`,
        performedById: 'user_1',
      });
      movementFindFirstOrThrow.mockResolvedValue({ id: 'mov_in' });
      branchFindMany.mockResolvedValue([]);

      await service.transfer(input, 'user_1');

      // Un asiento manual con la misma `reference` no cumple estos filtros.
      expect(movementFindFirstOrThrow).toHaveBeenCalledWith({
        where: {
          reference: `transfer_${ID}`,
          reason: MovementReason.TRANSFER,
          direction: MovementDirection.IN,
          itemId: 'item_1',
          branchId: 'branch_2',
          sourceBranchId: 'branch_1',
          performedById: 'user_1',
        },
      });
    });

    it('id ocupado por otro usuario: 409 ID_CONFLICT', async () => {
      movementFindUnique.mockResolvedValue({
        id: ID,
        direction: MovementDirection.OUT,
        reason: MovementReason.TRANSFER,
        reference: `transfer_${ID}`,
        destinationBranchId: 'branch_2',
        performedById: 'otro',
      });

      await expect(service.transfer(input, 'user_1')).rejects.toMatchObject({
        response: { code: ERROR_CODES.ID_CONFLICT },
      });
      expect(movementCreate).not.toHaveBeenCalled();
    });

    it('un id que es de un movimiento que no es traspaso: 409 ID_CONFLICT', async () => {
      movementFindUnique.mockResolvedValue({
        id: ID,
        direction: MovementDirection.IN,
        reason: MovementReason.PURCHASE,
        reference: null,
        destinationBranchId: null,
        performedById: 'user_1',
      });

      await expect(service.transfer(input, 'user_1')).rejects.toMatchObject({
        response: { code: ERROR_CODES.ID_CONFLICT },
      });
    });
  });
});
