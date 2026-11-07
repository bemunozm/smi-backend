import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { ERROR_CODES } from '../common/errors/error-codes';
import { PrismaService } from '../common/prisma/prisma.service';
import { buildSession, prismaError } from '../common/testing/fixtures';
import { OperatorsService } from './operators.service';

const USER = 'user_1';
const OMIT_RUT = { rut: true };

describe('OperatorsService', () => {
  let service: OperatorsService;

  const findMany = jest.fn();
  const findUnique = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const deleteFn = jest.fn();
  const userFindUnique = jest.fn();
  const userFindMany = jest.fn();

  beforeEach(async () => {
    [
      findMany,
      findUnique,
      create,
      update,
      deleteFn,
      userFindUnique,
      userFindMany,
    ].forEach((m) => m.mockReset());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperatorsService,
        {
          provide: PrismaService,
          useValue: {
            operator: {
              findMany,
              findUnique,
              create,
              update,
              delete: deleteFn,
            },
            user: { findUnique: userFindUnique, findMany: userFindMany },
          },
        },
      ],
    }).compile();

    service = module.get<OperatorsService>(OperatorsService);
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

      await service.findAll({ q: 'rojas' });

      expect(findMany).toHaveBeenCalledWith({
        where: { name: { contains: 'rojas', mode: 'insensitive' } },
        orderBy: { name: 'asc' },
      });
    });

    describe('rut solo para ADMIN/SUPERVISOR', () => {
      it('sin session (uso interno, ej. assertActive), NO omite rut — comportamiento previo intacto', async () => {
        findMany.mockResolvedValue([]);

        await service.findAll({});

        expect(findMany).toHaveBeenCalledWith({
          where: {},
          orderBy: { name: 'asc' },
        });
      });

      it('ADMIN ve el rut (sin omit)', async () => {
        findMany.mockResolvedValue([]);

        await service.findAll({}, buildSession('u1', 'ADMIN'));

        expect(findMany).toHaveBeenCalledWith({
          where: {},
          orderBy: { name: 'asc' },
        });
      });

      it('SUPERVISOR ve el rut (sin omit)', async () => {
        findMany.mockResolvedValue([]);

        await service.findAll({}, buildSession('u1', 'SUPERVISOR'));

        expect(findMany).toHaveBeenCalledWith({
          where: {},
          orderBy: { name: 'asc' },
        });
      });

      it('MANTENEDOR NO ve el rut (omit)', async () => {
        findMany.mockResolvedValue([]);

        await service.findAll({}, buildSession('u1', 'MANTENEDOR'));

        expect(findMany).toHaveBeenCalledWith(
          expect.objectContaining({ omit: OMIT_RUT }),
        );
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

    it('sin session, NO omite rut (uso interno de assertActive)', async () => {
      findUnique.mockResolvedValue({ id: 'op_1', name: 'X', rut: '1-9' });

      await service.findOne('op_1');

      expect(findUnique).toHaveBeenCalledWith({
        where: { id: 'op_1' },
      });
    });

    it('MANTENEDOR no ve rut vía findOne', async () => {
      findUnique.mockResolvedValue({ id: 'op_1', name: 'X' });

      await service.findOne('op_1', buildSession('u1', 'MANTENEDOR'));

      expect(findUnique).toHaveBeenCalledWith({
        where: { id: 'op_1' },
        omit: OMIT_RUT,
      });
    });

    it('ADMIN/SUPERVISOR sí ven rut vía findOne', async () => {
      findUnique.mockResolvedValue({ id: 'op_1', name: 'X', rut: '1-9' });

      await service.findOne('op_1', buildSession('u1', 'SUPERVISOR'));

      expect(findUnique).toHaveBeenCalledWith({
        where: { id: 'op_1' },
      });
    });

    it('sigue lanzando 404 si no existe, aun con la sesión redactada', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.findOne('missing', buildSession('u1', 'MANTENEDOR')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('crea el operador en el caso feliz, sin RUT', async () => {
      const dto = { name: 'Patricio Rojas' };
      create.mockResolvedValue({ id: 'op_1', ...dto, rut: null });

      const result = await service.create(dto, USER);

      expect(create).toHaveBeenCalledWith({
        data: { ...dto, createdById: USER },
      });
      expect(result).toEqual({ id: 'op_1', ...dto, rut: null });
    });

    it('normaliza el RUT al formato canónico antes de persistir', async () => {
      const dto = { name: 'Luis Contreras', rut: '12.345.678-5' };
      create.mockResolvedValue({
        id: 'op_2',
        name: dto.name,
        rut: '12345678-5',
      });

      await service.create(dto, USER);

      expect(create).toHaveBeenCalledWith({
        data: { name: dto.name, rut: '12345678-5', createdById: USER },
      });
    });

    it('mapea el P2002 de rut a ConflictException con el rut normalizado', async () => {
      const dto = { name: 'Marcelo Soto', rut: '11111111-1' };
      create.mockRejectedValue(prismaError('P2002', { target: ['rut'] }));

      await expect(service.create(dto, USER)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.create(dto, USER)).rejects.toThrow(
        'Ya existe un operador con el RUT "11111111-1"',
      );
    });

    describe('id del cliente (reintento offline)', () => {
      const ID = '11111111-1111-4111-8111-111111111111';

      it('replay del mismo usuario: devuelve la fila sin crear', async () => {
        findUnique
          .mockResolvedValueOnce({ createdById: USER })
          .mockResolvedValueOnce({ id: ID, name: 'Patricio' });

        const result = await service.create({ id: ID, name: 'Patricio' }, USER);

        expect(result).toEqual({ id: ID, name: 'Patricio' });
        expect(create).not.toHaveBeenCalled();
      });

      it('id ocupado por otro usuario: 409 ID_CONFLICT', async () => {
        findUnique.mockResolvedValueOnce({ createdById: 'otro' });

        await expect(
          service.create({ id: ID, name: 'Patricio' }, USER),
        ).rejects.toMatchObject({
          response: { code: ERROR_CODES.ID_CONFLICT },
        });
      });

      it('P2002 por RUT repetido NO es una carrera: el 409 de siempre', async () => {
        findUnique.mockResolvedValue(null);
        create.mockRejectedValue(prismaError('P2002', { target: ['rut'] }));

        const error = await service
          .create({ id: ID, name: 'P', rut: '11111111-1' }, USER)
          .catch((e: unknown) => e);

        expect((error as ConflictException).message).toBe(
          'Ya existe un operador con el RUT "11111111-1"',
        );
      });
    });

    it('re-lanza errores de Prisma no reconocidos sin envolverlos', async () => {
      const otro = prismaError('P2025');
      create.mockRejectedValue(otro);

      await expect(service.create({ name: 'X' }, USER)).rejects.toBe(otro);
    });
  });

  describe('update', () => {
    it('actualiza el operador en el caso feliz', async () => {
      findUnique.mockResolvedValue({ id: 'op_1' });
      update.mockResolvedValue({ id: 'op_1', name: 'Cristian Araya' });

      const result = await service.update('op_1', { name: 'Cristian Araya' });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'op_1' },
        data: { name: 'Cristian Araya' },
      });
      expect(result).toEqual({ id: 'op_1', name: 'Cristian Araya' });
    });

    it('normaliza el RUT si viene en el body', async () => {
      findUnique.mockResolvedValue({ id: 'op_1' });
      update.mockResolvedValue({ id: 'op_1', rut: '40000000-K' });

      await service.update('op_1', { rut: '40000000-k' });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'op_1' },
        data: { rut: '40000000-K' },
      });
    });

    it('lanza NotFoundException si no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.update('missing', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(update).not.toHaveBeenCalled();
    });

    it('mapea el P2002 de rut a ConflictException', async () => {
      findUnique.mockResolvedValue({ id: 'op_1' });
      update.mockRejectedValue(prismaError('P2002', { target: ['rut'] }));

      await expect(
        service.update('op_1', { rut: '11111111-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('remove', () => {
    it('elimina el operador cuando no tiene registros asociados', async () => {
      findUnique.mockResolvedValue({
        id: 'op_1',
        name: 'Patricio Rojas',
        _count: { horometros: 0 },
      });

      await service.remove('op_1');

      expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'op_1' } });
    });

    it('bloquea el borrado si tiene registros de horómetro asociados', async () => {
      findUnique.mockResolvedValue({
        id: 'op_1',
        name: 'Patricio Rojas',
        _count: { horometros: 3 },
      });

      await expect(service.remove('op_1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('el 409 por uso trae code OPERATOR_IN_USE en el body (passthrough del filtro global)', async () => {
      findUnique.mockResolvedValue({
        id: 'op_1',
        name: 'Patricio Rojas',
        _count: { horometros: 3 },
      });

      expect.assertions(1);
      try {
        await service.remove('op_1');
      } catch (error: unknown) {
        const response = (error as ConflictException).getResponse();
        expect(response).toMatchObject({ code: 'OPERATOR_IN_USE' });
      }
    });

    // `TrabajoExtraordinario.operatorId` es FK real a `Operator`
    // (`onDelete: SetNull`, igual que `horometros`)
    // — un borrado físico dejaría ese historial sin operador de catálogo de
    // forma silenciosa.
    it('bloquea el borrado si tiene trabajos extraordinarios asociados', async () => {
      findUnique.mockResolvedValue({
        id: 'op_1',
        name: 'Patricio Rojas',
        _count: { horometros: 0, trabajosExtra: 2 },
      });

      await expect(service.remove('op_1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('el 409 por trabajos extra trae code OPERATOR_IN_USE en el body', async () => {
      findUnique.mockResolvedValue({
        id: 'op_1',
        name: 'Patricio Rojas',
        _count: { horometros: 0, trabajosExtra: 1 },
      });

      expect.assertions(1);
      try {
        await service.remove('op_1');
      } catch (error: unknown) {
        const response = (error as ConflictException).getResponse();
        expect(response).toMatchObject({ code: 'OPERATOR_IN_USE' });
      }
    });

    // `Equipment.currentOperatorId` es FK real a `Operator` (`onDelete:
    // SetNull`) — un borrado físico dejaría el equipo sin
    // operador de forma silenciosa, así que se bloquea igual que con
    // `horometros`.
    it('bloquea el borrado si el operador está asignado a un equipo (currentOperatorId)', async () => {
      findUnique.mockResolvedValue({
        id: 'op_1',
        name: 'Patricio Rojas',
        _count: { horometros: 0, trabajosExtra: 0, assignedEquipment: 1 },
      });

      await expect(service.remove('op_1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('el 409 por asignación de equipo trae code OPERATOR_IN_USE en el body', async () => {
      findUnique.mockResolvedValue({
        id: 'op_1',
        name: 'Patricio Rojas',
        _count: { horometros: 0, trabajosExtra: 0, assignedEquipment: 2 },
      });

      expect.assertions(1);
      try {
        await service.remove('op_1');
      } catch (error: unknown) {
        const response = (error as ConflictException).getResponse();
        expect(response).toMatchObject({ code: 'OPERATOR_IN_USE' });
      }
    });

    it('lanza NotFoundException si no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('assertActive', () => {
    it('devuelve el operador cuando existe y está activo', async () => {
      findUnique.mockResolvedValue({
        id: 'op_1',
        name: 'Patricio Rojas',
        isActive: true,
      });

      const result = await service.assertActive('op_1');

      expect(result).toMatchObject({ id: 'op_1', name: 'Patricio Rojas' });
    });

    it('lanza 409 OPERATOR_INACTIVE si existe pero está desactivado', async () => {
      findUnique.mockResolvedValue({
        id: 'op_1',
        name: 'Patricio Rojas',
        isActive: false,
      });

      expect.assertions(2);
      try {
        await service.assertActive('op_1');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'OPERATOR_INACTIVE',
        });
      }
    });

    it('lanza NotFoundException si el operador no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.assertActive('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('supervisor habitual', () => {
    const admin = buildSession('admin_1', 'ADMIN');
    const supervisor = buildSession('sup_1', 'SUPERVISOR');

    it('la lista trae el nombre del supervisor habitual de cada operador', async () => {
      findMany.mockResolvedValue([
        { id: 'op_1', name: 'Milton Mosquera', supervisorHabitualId: 'sup_1' },
        { id: 'op_2', name: 'Jose Farias', supervisorHabitualId: null },
      ]);
      userFindMany.mockResolvedValue([
        { id: 'sup_1', name: 'Limbert Villacorta' },
      ]);

      const res = await service.findAll({}, admin);

      expect(res.map((o) => o.supervisorHabitualNombre)).toEqual([
        'Limbert Villacorta',
        null,
      ]);
    });

    it('el ADMIN lo asigna a un usuario SUPERVISOR', async () => {
      findUnique.mockResolvedValue({ id: 'op_1' });
      userFindUnique.mockResolvedValue({ role: 'SUPERVISOR' });
      update.mockResolvedValue({ id: 'op_1' });

      await service.update(
        'op_1',
        { supervisorHabitualId: 'sup_1' },
        undefined,
        admin,
      );

      expect(update).toHaveBeenCalledWith({
        where: { id: 'op_1' },
        data: { supervisorHabitualId: 'sup_1' },
      });
    });

    it('un SUPERVISOR no reparte la cuadrilla (403), aunque sí edite el resto', async () => {
      findUnique.mockResolvedValue({ id: 'op_1' });

      await expect(
        service.update(
          'op_1',
          { supervisorHabitualId: 'sup_1' },
          undefined,
          supervisor,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(update).not.toHaveBeenCalled();

      update.mockResolvedValue({ id: 'op_1' });
      await service.update(
        'op_1',
        { name: 'Milton M.' },
        undefined,
        supervisor,
      );
      expect(update).toHaveBeenCalled();
    });

    it('tiene que ser un supervisor: otro rol o un id que no existe es 400', async () => {
      findUnique.mockResolvedValue({ id: 'op_1' });
      userFindUnique.mockResolvedValueOnce({ role: 'MANTENEDOR' });
      await expect(
        service.update(
          'op_1',
          { supervisorHabitualId: 'm_1' },
          undefined,
          admin,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      userFindUnique.mockResolvedValueOnce(null);
      await expect(
        service.update('op_1', { supervisorHabitualId: 'x' }, undefined, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('null lo quita', async () => {
      findUnique.mockResolvedValue({ id: 'op_1' });
      update.mockResolvedValue({ id: 'op_1' });

      await service.update(
        'op_1',
        { supervisorHabitualId: null },
        undefined,
        admin,
      );

      expect(userFindUnique).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith({
        where: { id: 'op_1' },
        data: { supervisorHabitualId: null },
      });
    });
  });
});
