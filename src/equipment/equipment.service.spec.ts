import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  ControlUnit,
  EquipmentClass,
  EquipmentStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { CreateEquipmentDto } from './dto/create-equipment.dto';
import { EquipmentService } from './equipment.service';

const SIN_REGISTROS = {
  combustibles: 0,
  horometros: 0,
  trabajosExtra: 0,
  hallazgos: 0,
  movimientos: 0,
};

/** Construye un error de Prisma real (no un duck-type) para que el `instanceof`
 * que usa `EquipmentService` en el mapeo de errores lo reconozca. */
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

const DTO_BASE: CreateEquipmentDto = {
  internalCode: 'EX-001',
  equipmentClass: EquipmentClass.HEAVY,
  type: 'Excavadora',
  brand: 'Volvo',
  model: 'EC210',
  controlUnit: ControlUnit.HOURS,
};

describe('EquipmentService', () => {
  let service: EquipmentService;

  const findMany = jest.fn();
  const findUnique = jest.fn();
  const count = jest.fn();
  const groupBy = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const deleteFn = jest.fn();

  beforeEach(async () => {
    [findMany, findUnique, count, groupBy, create, update, deleteFn].forEach(
      (m) => m.mockReset(),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EquipmentService,
        {
          provide: PrismaService,
          useValue: {
            equipment: {
              findMany,
              findUnique,
              count,
              groupBy,
              create,
              update,
              delete: deleteFn,
            },
          },
        },
      ],
    }).compile();

    service = module.get<EquipmentService>(EquipmentService);
  });

  describe('findAll', () => {
    it('filtra por status y ordena por internalCode', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({ status: EquipmentStatus.OPERATIONAL });

      expect(findMany).toHaveBeenCalledWith({
        where: { status: EquipmentStatus.OPERATIONAL },
        orderBy: { internalCode: 'asc' },
      });
    });

    it('filtra por equipmentClass', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({ equipmentClass: EquipmentClass.HEAVY });

      expect(findMany).toHaveBeenCalledWith({
        where: { equipmentClass: EquipmentClass.HEAVY },
        orderBy: { internalCode: 'asc' },
      });
    });

    it('filtra por homeBranchId', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({ homeBranchId: 'branch_1' });

      expect(findMany).toHaveBeenCalledWith({
        where: { homeBranchId: 'branch_1' },
        orderBy: { internalCode: 'asc' },
      });
    });

    it('la búsqueda libre cubre internalCode, licensePlate, marca y modelo', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({ q: 'volvo' });

      const [{ where }] = findMany.mock.calls[0] as [
        { where: { OR: unknown[] } },
      ];
      expect(where.OR).toHaveLength(4);
    });
  });

  describe('resumen', () => {
    it('devuelve los 3 estados aunque groupBy solo traiga los que tienen filas', async () => {
      count.mockResolvedValue(3);
      groupBy.mockResolvedValue([
        { status: EquipmentStatus.OPERATIONAL, _count: { _all: 2 } },
        { status: EquipmentStatus.IN_WORKSHOP, _count: { _all: 1 } },
      ]);

      const resumen = await service.resumen();

      expect(resumen).toEqual({
        total: 3,
        disponibles: 2,
        porEstado: {
          OPERATIONAL: 2,
          IN_WORKSHOP: 1,
          OUT_OF_SERVICE: 0,
        },
      });
    });
  });

  describe('create', () => {
    it('crea el equipo en el caso feliz', async () => {
      create.mockResolvedValue({ id: 'eq_1', ...DTO_BASE });

      const result = await service.create(DTO_BASE);

      expect(create).toHaveBeenCalledWith({ data: DTO_BASE });
      expect(result).toEqual({ id: 'eq_1', ...DTO_BASE });
    });

    it('mapea el P2002 de internal_code a ConflictException con el código', async () => {
      create.mockRejectedValue(
        prismaError('P2002', { target: ['internal_code'] }),
      );

      await expect(service.create(DTO_BASE)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.create(DTO_BASE)).rejects.toThrow(
        'Ya existe un equipo con el código "EX-001"',
      );
    });

    it('mapea el P2002 de license_plate a ConflictException con la patente', async () => {
      const dto = { ...DTO_BASE, licensePlate: 'ABCD12' };
      create.mockRejectedValue(
        prismaError('P2002', { target: ['license_plate'] }),
      );

      await expect(service.create(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.create(dto)).rejects.toThrow(
        'Ya existe un equipo con la patente "ABCD12"',
      );
    });

    it('mapea un P2002 sin target reconocido a un ConflictException genérico', async () => {
      create.mockRejectedValue(prismaError('P2002', { target: ['otra_col'] }));

      await expect(service.create(DTO_BASE)).rejects.toThrow(
        'Ya existe un equipo con esos datos únicos (código o patente)',
      );
    });

    it('mapea el P2003 (homeBranchId inexistente) a BadRequestException', async () => {
      create.mockRejectedValue(prismaError('P2003'));

      await expect(
        service.create({ ...DTO_BASE, homeBranchId: 'missing' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create({ ...DTO_BASE, homeBranchId: 'missing' }),
      ).rejects.toThrow('La sucursal indicada no existe');
    });

    it('re-lanza errores de Prisma no reconocidos sin envolverlos', async () => {
      const otro = prismaError('P2025');
      create.mockRejectedValue(otro);

      await expect(service.create(DTO_BASE)).rejects.toBe(otro);
    });
  });

  describe('update', () => {
    it('actualiza el equipo en el caso feliz', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({ id: 'eq_1', brand: 'Komatsu' });

      const result = await service.update('eq_1', { brand: 'Komatsu' });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { brand: 'Komatsu' },
      });
      expect(result).toEqual({ id: 'eq_1', brand: 'Komatsu' });
    });

    it('limpia licensePlate cuando se envía null explícito', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({ id: 'eq_1', licensePlate: null });

      await service.update('eq_1', { licensePlate: null });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { licensePlate: null },
      });
    });

    it('limpia year cuando se envía null explícito', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({ id: 'eq_1', year: null });

      await service.update('eq_1', { year: null });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { year: null },
      });
    });

    it('limpia homeBranchId cuando se envía null explícito', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({ id: 'eq_1', homeBranchId: null });

      await service.update('eq_1', { homeBranchId: null });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { homeBranchId: null },
      });
    });

    it('un update parcial que no incluye licensePlate/year/homeBranchId las deja intactas', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({ id: 'eq_1', brand: 'Komatsu' });

      await service.update('eq_1', { brand: 'Komatsu' });

      const [{ data }] = update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).not.toHaveProperty('licensePlate');
      expect(data).not.toHaveProperty('year');
      expect(data).not.toHaveProperty('homeBranchId');
    });

    it('lanza NotFoundException si el equipo no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.update('missing', { brand: 'Komatsu' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(update).not.toHaveBeenCalled();
    });

    it('mapea el P2002 a ConflictException', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockRejectedValue(
        prismaError('P2002', { target: ['internal_code'] }),
      );

      await expect(
        service.update('eq_1', { brand: 'Komatsu' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('mapea el P2003 (homeBranchId inexistente) a BadRequestException', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockRejectedValue(prismaError('P2003'));

      await expect(
        service.update('eq_1', { homeBranchId: 'missing' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updateStatus', () => {
    it('actualiza el estado en el caso feliz', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({
        id: 'eq_1',
        status: EquipmentStatus.IN_WORKSHOP,
      });

      const result = await service.updateStatus('eq_1', {
        status: EquipmentStatus.IN_WORKSHOP,
      });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { status: EquipmentStatus.IN_WORKSHOP },
      });
      expect(result).toEqual({
        id: 'eq_1',
        status: EquipmentStatus.IN_WORKSHOP,
      });
    });

    it('lanza NotFoundException si el equipo no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.updateStatus('missing', {
          status: EquipmentStatus.IN_WORKSHOP,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('devuelve la ficha del equipo cuando existe', async () => {
      const ficha = { id: 'eq_1', internalCode: 'EX-001' };
      findUnique.mockResolvedValue(ficha);

      const result = await service.findOne('eq_1');

      expect(result).toEqual(ficha);
    });

    it('lanza NotFoundException si el equipo no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('elimina el equipo cuando no tiene historial', async () => {
      findUnique.mockResolvedValue({
        id: 'eq_1',
        internalCode: 'EX-001',
        _count: SIN_REGISTROS,
      });

      await service.remove('eq_1');

      expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'eq_1' } });
    });

    it('bloquea el borrado si el equipo tiene registros asociados', async () => {
      findUnique.mockResolvedValue({
        id: 'eq_1',
        internalCode: 'EX-001',
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
