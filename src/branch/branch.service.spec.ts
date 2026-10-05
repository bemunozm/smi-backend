import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { ERROR_CODES } from '../common/errors/error-codes';
import { PrismaService } from '../common/prisma/prisma.service';
import { BranchService } from './branch.service';

const USER = 'user_1';

/** Construye un error de Prisma real (no un duck-type) para que el `instanceof`
 * que usa `BranchService` en el mapeo de errores lo reconozca. */
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

describe('BranchService', () => {
  let service: BranchService;

  const findMany = jest.fn();
  const findUnique = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const deleteFn = jest.fn();
  const queryRaw = jest.fn();

  beforeEach(async () => {
    [findMany, findUnique, create, update, deleteFn, queryRaw].forEach((m) =>
      m.mockReset(),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BranchService,
        {
          provide: PrismaService,
          useValue: {
            branch: { findMany, findUnique, create, update, delete: deleteFn },
            $queryRaw: queryRaw,
            $transaction: (fn: (tx: unknown) => unknown) =>
              fn({
                branch: { findUnique, update },
                $queryRaw: queryRaw,
              }),
          },
        },
      ],
    }).compile();

    service = module.get<BranchService>(BranchService);
  });

  describe('findAll', () => {
    it('filtra por isActive', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({ isActive: true });

      expect(findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      });
    });

    it('busca por nombre', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({ q: 'norte' });

      expect(findMany).toHaveBeenCalledWith({
        where: { name: { contains: 'norte', mode: 'insensitive' } },
        orderBy: { name: 'asc' },
      });
    });
  });

  describe('findOne', () => {
    it('lanza NotFoundException si no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('crea la sucursal en el caso feliz', async () => {
      const dto = { name: 'Sucursal Norte', address: 'Av. Principal 123' };
      create.mockResolvedValue({ id: 'branch_1', ...dto });

      const result = await service.create(dto, USER);

      expect(create).toHaveBeenCalledWith({
        data: { ...dto, createdById: USER },
      });
      expect(result).toEqual({ id: 'branch_1', ...dto });
    });

    describe('id del cliente (reintento offline)', () => {
      const ID = '11111111-1111-4111-8111-111111111111';

      it('replay del mismo usuario: devuelve la fila sin createdById y sin crear', async () => {
        findUnique.mockResolvedValue({
          id: ID,
          name: 'Norte',
          createdById: USER,
        });

        const result = await service.create({ id: ID, name: 'Norte' }, USER);

        expect(result).toEqual({ id: ID, name: 'Norte' });
        expect(create).not.toHaveBeenCalled();
      });

      it('id ocupado por otro usuario: 409 ID_CONFLICT', async () => {
        findUnique.mockResolvedValue({
          id: ID,
          name: 'Norte',
          createdById: 'otro',
        });

        await expect(
          service.create({ id: ID, name: 'Norte' }, USER),
        ).rejects.toMatchObject({
          response: { code: ERROR_CODES.ID_CONFLICT },
        });
        expect(create).not.toHaveBeenCalled();
      });

      it('carrera sobre la PK: relee y devuelve la fila ganadora', async () => {
        findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: ID, name: 'Norte', createdById: USER });
        create.mockRejectedValue(prismaError('P2002', { target: ['id'] }));

        const result = await service.create({ id: ID, name: 'Norte' }, USER);

        expect(result).toEqual({ id: ID, name: 'Norte' });
      });

      it('P2002 por nombre repetido sigue siendo el 409 de siempre, no ID_CONFLICT', async () => {
        findUnique.mockResolvedValue(null);
        create.mockRejectedValue(prismaError('P2002', { target: ['name'] }));

        const error = await service
          .create({ id: ID, name: 'Norte' }, USER)
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).message).toBe(
          'Ya existe una sucursal con el nombre "Norte"',
        );
      });
    });

    it('mapea el P2002 de name a ConflictException con el nombre', async () => {
      const dto = { name: 'Sucursal Norte' };
      create.mockRejectedValue(prismaError('P2002', { target: ['name'] }));

      await expect(service.create(dto, USER)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.create(dto, USER)).rejects.toThrow(
        'Ya existe una sucursal con el nombre "Sucursal Norte"',
      );
    });

    it('re-lanza errores de Prisma no reconocidos sin envolverlos', async () => {
      const otro = prismaError('P2025');
      create.mockRejectedValue(otro);

      await expect(service.create({ name: 'X' }, USER)).rejects.toBe(otro);
    });
  });

  describe('update', () => {
    it('actualiza la sucursal en el caso feliz', async () => {
      findUnique.mockResolvedValue({ id: 'branch_1' });
      update.mockResolvedValue({ id: 'branch_1', name: 'Sucursal Sur' });

      const result = await service.update('branch_1', {
        name: 'Sucursal Sur',
      });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'branch_1' },
        data: { name: 'Sucursal Sur' },
      });
      expect(result).toEqual({ id: 'branch_1', name: 'Sucursal Sur' });
    });

    describe('X-Expected', () => {
      beforeEach(() => {
        queryRaw.mockResolvedValue([{ id: 'branch_1' }]);
      });

      it('con la base vigente escribe bajo bloqueo', async () => {
        findUnique
          .mockResolvedValueOnce({ id: 'branch_1' })
          .mockResolvedValueOnce({
            name: 'Norte',
            address: null,
            isActive: true,
          });
        update.mockResolvedValue({ id: 'branch_1', name: 'Sur' });

        await service.update('branch_1', { name: 'Sur' }, { name: 'Norte' });

        expect(queryRaw).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledTimes(1);
      });

      it('si alguien cambió el nombre mientras tanto: 409 STALE_UPDATE y no escribe', async () => {
        findUnique
          .mockResolvedValueOnce({ id: 'branch_1' })
          .mockResolvedValueOnce({
            name: 'Oeste',
            address: null,
            isActive: true,
          });

        await expect(
          service.update('branch_1', { name: 'Sur' }, { name: 'Norte' }),
        ).rejects.toMatchObject({
          response: { code: ERROR_CODES.STALE_UPDATE },
        });
        expect(update).not.toHaveBeenCalled();
      });

      it('el reintento de una edición ya aplicada (actual == deseado) pasa', async () => {
        findUnique
          .mockResolvedValueOnce({ id: 'branch_1' })
          .mockResolvedValueOnce({
            name: 'Sur',
            address: null,
            isActive: true,
          });
        update.mockResolvedValue({ id: 'branch_1', name: 'Sur' });

        await expect(
          service.update('branch_1', { name: 'Sur' }, { name: 'Norte' }),
        ).resolves.toEqual({ id: 'branch_1', name: 'Sur' });
      });
    });

    it('lanza NotFoundException si no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.update('missing', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(update).not.toHaveBeenCalled();
    });

    it('mapea el P2002 de name a ConflictException con el nombre', async () => {
      findUnique.mockResolvedValue({ id: 'branch_1' });
      update.mockRejectedValue(prismaError('P2002', { target: ['name'] }));

      await expect(
        service.update('branch_1', { name: 'Sucursal Norte' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'branch_1' },
        data: { name: 'Sucursal Norte' },
      });
    });
  });

  describe('remove', () => {
    it('elimina la sucursal cuando no tiene equipos asociados', async () => {
      findUnique.mockResolvedValue({
        id: 'branch_1',
        name: 'Sucursal Norte',
        _count: { homedEquipment: 0 },
      });

      await service.remove('branch_1');

      expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'branch_1' } });
    });

    it('bloquea el borrado si tiene equipos homologados', async () => {
      findUnique.mockResolvedValue({
        id: 'branch_1',
        name: 'Sucursal Norte',
        _count: { homedEquipment: 3 },
      });

      await expect(service.remove('branch_1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
