import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../../common/prisma/prisma.service';
import { CategoriesService } from './categories.service';

describe('CategoriesService', () => {
  let service: CategoriesService;

  const findMany = jest.fn();
  const findFirst = jest.fn();
  const findUnique = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const deleteFn = jest.fn();

  beforeEach(async () => {
    [findMany, findFirst, findUnique, create, update, deleteFn].forEach(
      (mock) => mock.mockReset(),
    );
    findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        {
          provide: PrismaService,
          useValue: {
            itemCategory: {
              findMany,
              findFirst,
              findUnique,
              create,
              update,
              delete: deleteFn,
            },
          },
        },
      ],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
  });

  describe('create', () => {
    it('rechaza un nombre que ya existe con otra caja', async () => {
      // El índice único de Postgres es sensible a mayúsculas: sin la
      // comprobación previa, "filtros" entraría al lado de "Filtros" y el
      // selector mostraría las dos.
      findFirst.mockResolvedValue({ name: 'Filtros' });

      await expect(service.create({ name: 'filtros' })).rejects.toThrow(
        ConflictException,
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('crea la categoría cuando el nombre está libre', async () => {
      create.mockResolvedValue({ id: 'c1', name: 'Filtros' });

      await service.create({ name: 'Filtros' });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { name: 'Filtros' } }),
      );
    });
  });

  describe('update', () => {
    it('deja renombrar la categoría a su propio nombre', async () => {
      // El choque es contra OTRA fila: si `assertNombreLibre` no se excluyera a
      // sí misma, corregir solo el acento sería imposible.
      findUnique.mockResolvedValue({
        id: 'c1',
        name: 'Filtros',
        _count: { items: 3 },
      });
      update.mockResolvedValue({ id: 'c1', name: 'Filtros' });

      await service.update('c1', { name: 'Filtros' });

      expect(findFirst).toHaveBeenCalledWith({
        where: {
          name: { equals: 'Filtros', mode: 'insensitive' },
          id: { not: 'c1' },
        },
        select: { name: true },
      });
      expect(update).toHaveBeenCalled();
    });

    it('falla si la categoría no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.update('nope', { name: 'X' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('bloquea el borrado si la categoría tiene ítems', async () => {
      // `onDelete: SetNull` dejaría 12 ítems sin categoría en silencio. Se
      // prefiere el error explícito: reasignar es decisión de bodega.
      findUnique.mockResolvedValue({
        id: 'c1',
        name: 'Filtros',
        _count: { items: 12 },
      });

      await expect(service.remove('c1')).rejects.toThrow(ConflictException);
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('borra la categoría vacía', async () => {
      findUnique.mockResolvedValue({
        id: 'c1',
        name: 'Filttros',
        _count: { items: 0 },
      });

      await service.remove('c1');

      expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'c1' } });
    });
  });

  describe('findAll', () => {
    it('busca por nombre sin distinguir mayúsculas', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({ q: 'neu' });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { name: { contains: 'neu', mode: 'insensitive' } },
          orderBy: { name: 'asc' },
        }),
      );
    });
  });
});
