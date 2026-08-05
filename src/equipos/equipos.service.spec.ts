import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EstadoEquipo } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { EquiposService } from './equipos.service';

const SIN_REGISTROS = {
  combustibles: 0,
  horometros: 0,
  trabajosExtra: 0,
  hallazgos: 0,
  movimientos: 0,
};

describe('EquiposService', () => {
  let service: EquiposService;

  const findMany = jest.fn();
  const findUnique = jest.fn();
  const count = jest.fn();
  const groupBy = jest.fn();
  const deleteFn = jest.fn();

  beforeEach(async () => {
    [findMany, findUnique, count, groupBy, deleteFn].forEach((m) =>
      m.mockReset(),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EquiposService,
        {
          provide: PrismaService,
          useValue: {
            equipo: { findMany, findUnique, count, groupBy, delete: deleteFn },
          },
        },
      ],
    }).compile();

    service = module.get<EquiposService>(EquiposService);
  });

  describe('findAll', () => {
    it('filtra por estado y ordena por código', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({ estado: EstadoEquipo.DISPONIBLE });

      expect(findMany).toHaveBeenCalledWith({
        where: { estado: EstadoEquipo.DISPONIBLE },
        orderBy: { codigo: 'asc' },
      });
    });

    it('la búsqueda libre cubre código, marca y modelo', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({ q: 'volvo' });

      const [{ where }] = findMany.mock.calls[0] as [
        { where: { OR: unknown[] } },
      ];
      expect(where.OR).toHaveLength(3);
    });
  });

  describe('resumen', () => {
    it('devuelve los 4 estados aunque groupBy solo traiga los que tienen filas', async () => {
      count.mockResolvedValue(3);
      groupBy.mockResolvedValue([
        { estado: EstadoEquipo.DISPONIBLE, _count: { _all: 2 } },
        { estado: EstadoEquipo.EN_RUTA, _count: { _all: 1 } },
      ]);

      const resumen = await service.resumen();

      expect(resumen).toEqual({
        total: 3,
        disponibles: 2,
        porEstado: {
          DISPONIBLE: 2,
          EN_RUTA: 1,
          EN_MANTENCION: 0,
          DE_BAJA: 0,
        },
      });
    });
  });

  describe('remove', () => {
    it('elimina el equipo cuando no tiene historial', async () => {
      findUnique.mockResolvedValue({
        id: 'eq_1',
        codigo: 'EX-001',
        _count: SIN_REGISTROS,
      });

      await service.remove('eq_1');

      expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'eq_1' } });
    });

    it('bloquea el borrado si el equipo tiene registros asociados', async () => {
      findUnique.mockResolvedValue({
        id: 'eq_1',
        codigo: 'EX-001',
        _count: { ...SIN_REGISTROS, hallazgos: 2 },
      });

      await expect(service.remove('eq_1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el equipo no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
