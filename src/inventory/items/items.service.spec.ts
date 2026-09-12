import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MovementReason, Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PrismaService } from '../../common/prisma/prisma.service';
import { StockService } from '../stock.service';
import { ItemsService } from './items.service';
import { UpdateItemDto } from './dto/update-item.dto';

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('mocked prisma error', {
    code,
    clientVersion: 'test',
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
    ].forEach((mock) => mock.mockReset());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ItemsService,
        {
          provide: PrismaService,
          useValue: {
            inventoryItem: itemDelegate,
            stockMovement: { findMany: jest.fn().mockResolvedValue([]) },
            // El create corre dentro de una transacción: el mock ejecuta el
            // callback con el mismo delegate, que es lo que hace Prisma.
            $transaction: (fn: (tx: unknown) => unknown) =>
              fn({ inventoryItem: itemDelegate }),
          },
        },
        {
          provide: StockService,
          useValue: { receive, adjustToCount: jest.fn() },
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

      await expect(service.remove('i1')).rejects.toThrow(/isActive=false/);
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
