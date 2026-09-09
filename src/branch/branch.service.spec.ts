import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { BranchService } from './branch.service';

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

  beforeEach(async () => {
    [findMany, findUnique, create, update, deleteFn].forEach((m) =>
      m.mockReset(),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BranchService,
        {
          provide: PrismaService,
          useValue: {
            branch: { findMany, findUnique, create, update, delete: deleteFn },
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

      const result = await service.create(dto);

      expect(create).toHaveBeenCalledWith({ data: dto });
      expect(result).toEqual({ id: 'branch_1', ...dto });
    });

    it('mapea el P2002 de name a ConflictException con el nombre', async () => {
      const dto = { name: 'Sucursal Norte' };
      create.mockRejectedValue(prismaError('P2002', { target: ['name'] }));

      await expect(service.create(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.create(dto)).rejects.toThrow(
        'Ya existe una sucursal con el nombre "Sucursal Norte"',
      );
    });

    it('re-lanza errores de Prisma no reconocidos sin envolverlos', async () => {
      const otro = prismaError('P2025');
      create.mockRejectedValue(otro);

      await expect(service.create({ name: 'X' })).rejects.toBe(otro);
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
