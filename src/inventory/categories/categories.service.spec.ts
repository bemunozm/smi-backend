import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { ERROR_CODES } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { prismaError } from '../../common/testing/fixtures';
import { CategoriesService } from './categories.service';

const USER = 'user_1';

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

      await expect(service.create({ name: 'filtros' }, USER)).rejects.toThrow(
        ConflictException,
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('crea la categoría cuando el nombre está libre', async () => {
      create.mockResolvedValue({ id: 'c1', name: 'Filtros' });

      await service.create({ name: 'Filtros' }, USER);

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { name: 'Filtros', createdById: USER },
          omit: { createdById: true },
        }),
      );
    });

    describe('id del cliente (reintento offline)', () => {
      const ID = '11111111-1111-4111-8111-111111111111';

      it('replay del mismo usuario: devuelve la fila actual sin crear ni validar el nombre', async () => {
        findUnique
          .mockResolvedValueOnce({ createdById: USER })
          .mockResolvedValueOnce({
            id: ID,
            name: 'Filtros',
            _count: { items: 0 },
          });

        const result = await service.create({ id: ID, name: 'Filtros' }, USER);

        expect(result).toEqual({
          id: ID,
          name: 'Filtros',
          _count: { items: 0 },
        });
        expect(create).not.toHaveBeenCalled();
        expect(findFirst).not.toHaveBeenCalled();
      });

      it('id ocupado por otro usuario: 409 ID_CONFLICT', async () => {
        findUnique.mockResolvedValueOnce({ createdById: 'otro' });

        await expect(
          service.create({ id: ID, name: 'Filtros' }, USER),
        ).rejects.toMatchObject({
          response: { code: ERROR_CODES.ID_CONFLICT },
        });
        expect(create).not.toHaveBeenCalled();
      });

      it('carrera sobre la PK: devuelve la fila ganadora', async () => {
        findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ createdById: USER })
          .mockResolvedValueOnce({
            id: ID,
            name: 'Filtros',
            _count: { items: 0 },
          });
        create.mockRejectedValue(prismaError('P2002', { target: ['id'] }));

        await expect(
          service.create({ id: ID, name: 'Filtros' }, USER),
        ).resolves.toMatchObject({ id: ID });
      });

      it('P2002 por nombre repetido sigue siendo el 409 de siempre', async () => {
        findUnique.mockResolvedValue(null);
        create.mockRejectedValue(prismaError('P2002', { target: ['name'] }));

        const error = await service
          .create({ id: ID, name: 'Filtros' }, USER)
          .catch((e: unknown) => e);

        expect((error as ConflictException).message).toBe(
          'Ya existe una categoría llamada "Filtros"',
        );
      });
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
    it('con `type` deja solo las categorías que tienen ítems de esa clase', async () => {
      // Ofrecer «Neumáticos y llantas» mientras se miran los suministros lleva
      // a un listado vacío y a pensar que se perdió el stock.
      findMany.mockResolvedValue([]);

      await service.findAll({ type: 'PART' });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { items: { some: { type: 'PART', isActive: true } } },
          include: {
            _count: {
              select: { items: { where: { type: 'PART', isActive: true } } },
            },
          },
        }),
      );
    });

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
