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

import { ROLES } from '../auth/roles';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateEquipmentDto } from './dto/create-equipment.dto';
import { EQUIPMENT_USAGE_INCLUDE, EquipmentService } from './equipment.service';

const SIN_REGISTROS = {
  combustibles: 0,
  horometros: 0,
  trabajosExtra: 0,
  hallazgos: 0,
  stockMovements: 0,
  documents: 0,
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
  const userFindMany = jest.fn();
  const userFindUnique = jest.fn();
  const registroHorometroFindMany = jest.fn();
  const equipmentDocumentFindMany = jest.fn();

  beforeEach(async () => {
    [
      findMany,
      findUnique,
      count,
      groupBy,
      create,
      update,
      deleteFn,
      userFindMany,
      userFindUnique,
      registroHorometroFindMany,
      equipmentDocumentFindMany,
    ].forEach((m) => m.mockReset());
    userFindMany.mockResolvedValue([]);
    // Sin turno abierto por defecto — los tests de `openShift` lo sobreescriben.
    registroHorometroFindMany.mockResolvedValue([]);
    // Sin documentos vencidos/por vencer por defecto — los tests de
    // `documentsAlert` lo sobreescriben.
    equipmentDocumentFindMany.mockResolvedValue([]);

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
            user: {
              findMany: userFindMany,
              findUnique: userFindUnique,
            },
            registroHorometro: {
              findMany: registroHorometroFindMany,
            },
            equipmentDocument: {
              findMany: equipmentDocumentFindMany,
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
        include: EQUIPMENT_USAGE_INCLUDE,
      });
    });

    it('filtra por equipmentClass', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({ equipmentClass: EquipmentClass.HEAVY });

      expect(findMany).toHaveBeenCalledWith({
        where: { equipmentClass: EquipmentClass.HEAVY },
        orderBy: { internalCode: 'asc' },
        include: EQUIPMENT_USAGE_INCLUDE,
      });
    });

    it('filtra por homeBranchId', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({ homeBranchId: 'branch_1' });

      expect(findMany).toHaveBeenCalledWith({
        where: { homeBranchId: 'branch_1' },
        orderBy: { internalCode: 'asc' },
        include: EQUIPMENT_USAGE_INCLUDE,
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

  describe('findAll — asignación, inUse y combustible', () => {
    it('resuelve operator/supervisor con UNA sola consulta batch, deriva inUse y toma el nivel del último horómetro', async () => {
      findMany.mockResolvedValue([
        {
          id: 'eq_1',
          currentOperatorId: 'user_op',
          currentSupervisorId: 'user_sup',
          horometros: [{ nivelCombustible: 62 }],
        },
        {
          id: 'eq_2',
          currentOperatorId: null,
          currentSupervisorId: null,
          horometros: [],
        },
      ]);
      userFindMany.mockResolvedValue([
        { id: 'user_op', name: 'Juan Operador' },
        { id: 'user_sup', name: 'Marcela Supervisora' },
      ]);

      const [enUso, disponible] = await service.findAll({});

      expect(userFindMany).toHaveBeenCalledTimes(1);
      expect(userFindMany).toHaveBeenCalledWith({
        where: { id: { in: ['user_op', 'user_sup'] } },
        select: { id: true, name: true },
      });
      expect(enUso).toMatchObject({
        operator: { id: 'user_op', name: 'Juan Operador' },
        supervisor: { id: 'user_sup', name: 'Marcela Supervisora' },
        inUse: true,
        currentFuelLevel: 62,
      });
      expect(enUso).not.toHaveProperty('horometros');
      expect(disponible).toMatchObject({
        operator: null,
        supervisor: null,
        inUse: false,
        currentFuelLevel: null,
      });
    });

    it('no consulta usuarios si ningún equipo tiene asignación (evita una query vacía)', async () => {
      findMany.mockResolvedValue([
        {
          id: 'eq_1',
          currentOperatorId: null,
          currentSupervisorId: null,
          horometros: [],
        },
      ]);

      await service.findAll({});

      expect(userFindMany).not.toHaveBeenCalled();
    });

    it('un id asignado sin usuario correspondiente (dato huérfano) se resuelve como null', async () => {
      findMany.mockResolvedValue([
        {
          id: 'eq_1',
          currentOperatorId: 'user_borrado',
          currentSupervisorId: null,
          horometros: [],
        },
      ]);
      userFindMany.mockResolvedValue([]);

      const [equipo] = await service.findAll({});

      expect(equipo).toMatchObject({ operator: null, inUse: true });
    });
  });

  describe('EQUIPMENT_USAGE_INCLUDE — currentFuelLevel', () => {
    it('filtra los horómetros SIN nivel de combustible en el propio include, para que "el último" sea el último CON nivel', () => {
      // No hay BD real en estos tests (jest unit, sin Docker/Postgres): lo
      // que se puede asertar acá es que el `include` que se manda a Prisma
      // excluye `nivelCombustible: null` en el `where` — así, aunque la
      // lectura de horómetro más reciente del equipo no tenga combustible
      // cargado, Prisma trae la anterior que sí lo tiene (take:1 sobre el
      // resultado YA filtrado, no sobre el crudo).
      expect(EQUIPMENT_USAGE_INCLUDE.horometros).toEqual({
        where: { nivelCombustible: { not: null } },
        orderBy: { fecha: 'desc' },
        take: 1,
        select: { nivelCombustible: true },
      });
    });

    it('shapeUsage toma currentFuelLevel del único horómetro que devuelve Prisma (ya filtrado por el include de arriba)', async () => {
      // Simula lo que Prisma devolvería con el `where` de EQUIPMENT_USAGE_INCLUDE:
      // la lectura más reciente sin nivel quedó descartada por la BD, así que
      // el service solo ve la anterior, que sí tiene nivel 62.
      findMany.mockResolvedValue([
        {
          id: 'eq_1',
          currentOperatorId: null,
          currentSupervisorId: null,
          horometros: [{ nivelCombustible: 62 }],
        },
      ]);

      const [equipo] = await service.findAll({});

      expect(equipo).toMatchObject({ currentFuelLevel: 62 });
    });
  });

  describe('findAll/findOne — openShift', () => {
    it('resuelve openShift con UNA sola consulta batch, usando distinct por equipoId', async () => {
      const fecha = new Date('2026-09-15T08:00:00.000Z');
      findMany.mockResolvedValue([
        {
          id: 'eq_1',
          currentOperatorId: null,
          currentSupervisorId: null,
          horometros: [],
        },
        {
          id: 'eq_2',
          currentOperatorId: null,
          currentSupervisorId: null,
          horometros: [],
        },
      ]);
      registroHorometroFindMany.mockResolvedValue([
        {
          id: 'r1',
          equipoId: 'eq_1',
          valorInicial: 100,
          operador: 'Juan Rojas',
          turno: 'DIURNO',
          fecha,
        },
      ]);

      const [conTurno, sinTurno] = await service.findAll({});

      expect(registroHorometroFindMany).toHaveBeenCalledTimes(1);
      expect(registroHorometroFindMany).toHaveBeenCalledWith({
        where: { equipoId: { in: ['eq_1', 'eq_2'] }, valorFinal: null },
        orderBy: { fecha: 'desc' },
        distinct: ['equipoId'],
        select: {
          id: true,
          equipoId: true,
          valorInicial: true,
          operador: true,
          turno: true,
          fecha: true,
        },
      });
      expect(conTurno).toMatchObject({
        openShift: {
          id: 'r1',
          valorInicial: 100,
          operador: 'Juan Rojas',
          turno: 'DIURNO',
          fecha,
        },
      });
      expect(sinTurno).toMatchObject({ openShift: null });
    });

    it('no consulta turnos abiertos si no hay equipos', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({});

      expect(registroHorometroFindMany).not.toHaveBeenCalled();
    });

    it('findOne expone openShift null cuando el equipo no tiene turno en curso', async () => {
      findUnique.mockResolvedValue({
        id: 'eq_1',
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      const result = await service.findOne('eq_1');

      expect(result).toMatchObject({ openShift: null });
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
      create.mockResolvedValue({
        id: 'eq_1',
        ...DTO_BASE,
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      const result = await service.create(DTO_BASE);

      expect(create).toHaveBeenCalledWith({
        data: DTO_BASE,
        include: EQUIPMENT_USAGE_INCLUDE,
      });
      expect(result).toMatchObject({ id: 'eq_1', ...DTO_BASE });
    });

    it('la ficha creada viene shapeada con operator/supervisor/inUse/currentFuelLevel (contrato que exige EquipmentResponseSchema en el front)', async () => {
      create.mockResolvedValue({
        id: 'eq_1',
        ...DTO_BASE,
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      const result = await service.create(DTO_BASE);

      expect(result).toMatchObject({
        operator: null,
        supervisor: null,
        inUse: false,
        currentFuelLevel: null,
      });
      expect(result).not.toHaveProperty('horometros');
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

    it('persiste photoUrl', async () => {
      const dto = {
        ...DTO_BASE,
        photoUrl: 'https://picsum.photos/seed/EX-001/400/300',
      };
      create.mockResolvedValue({
        id: 'eq_1',
        ...dto,
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      await service.create(dto);

      expect(create).toHaveBeenCalledWith({
        data: dto,
        include: EQUIPMENT_USAGE_INCLUDE,
      });
    });
  });

  describe('update', () => {
    it('actualiza el equipo en el caso feliz', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({
        id: 'eq_1',
        brand: 'Komatsu',
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      const result = await service.update('eq_1', { brand: 'Komatsu' });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { brand: 'Komatsu' },
        include: EQUIPMENT_USAGE_INCLUDE,
      });
      expect(result).toMatchObject({ id: 'eq_1', brand: 'Komatsu' });
    });

    it('la ficha actualizada viene shapeada con operator/supervisor/inUse/currentFuelLevel (contrato que exige EquipmentResponseSchema en el front)', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({
        id: 'eq_1',
        brand: 'Komatsu',
        currentOperatorId: 'user_op',
        currentSupervisorId: null,
        horometros: [{ nivelCombustible: 45 }],
      });
      userFindMany.mockResolvedValue([
        { id: 'user_op', name: 'Juan Operador' },
      ]);

      const result = await service.update('eq_1', { brand: 'Komatsu' });

      expect(result).toMatchObject({
        operator: { id: 'user_op', name: 'Juan Operador' },
        supervisor: null,
        inUse: true,
        currentFuelLevel: 45,
      });
      expect(result).not.toHaveProperty('horometros');
    });

    it('limpia licensePlate cuando se envía null explícito', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({
        id: 'eq_1',
        licensePlate: null,
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      await service.update('eq_1', { licensePlate: null });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { licensePlate: null },
        include: EQUIPMENT_USAGE_INCLUDE,
      });
    });

    it('limpia year cuando se envía null explícito', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({
        id: 'eq_1',
        year: null,
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      await service.update('eq_1', { year: null });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { year: null },
        include: EQUIPMENT_USAGE_INCLUDE,
      });
    });

    it('limpia homeBranchId cuando se envía null explícito', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({
        id: 'eq_1',
        homeBranchId: null,
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      await service.update('eq_1', { homeBranchId: null });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { homeBranchId: null },
        include: EQUIPMENT_USAGE_INCLUDE,
      });
    });

    it('un update parcial que no incluye licensePlate/year/homeBranchId las deja intactas', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({
        id: 'eq_1',
        brand: 'Komatsu',
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

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

    it('persiste photoUrl', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({
        id: 'eq_1',
        photoUrl: 'https://picsum.photos/seed/EX-001/400/300',
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      await service.update('eq_1', {
        photoUrl: 'https://picsum.photos/seed/EX-001/400/300',
      });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { photoUrl: 'https://picsum.photos/seed/EX-001/400/300' },
        include: EQUIPMENT_USAGE_INCLUDE,
      });
    });

    it('limpia photoUrl cuando se envía null explícito', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({
        id: 'eq_1',
        photoUrl: null,
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      await service.update('eq_1', { photoUrl: null });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { photoUrl: null },
        include: EQUIPMENT_USAGE_INCLUDE,
      });
    });
  });

  describe('updateStatus', () => {
    it('actualiza el estado en el caso feliz', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({
        id: 'eq_1',
        status: EquipmentStatus.IN_WORKSHOP,
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      const result = await service.updateStatus('eq_1', {
        status: EquipmentStatus.IN_WORKSHOP,
      });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { status: EquipmentStatus.IN_WORKSHOP },
        include: EQUIPMENT_USAGE_INCLUDE,
      });
      expect(result).toMatchObject({
        id: 'eq_1',
        status: EquipmentStatus.IN_WORKSHOP,
      });
    });

    it('la ficha con el estado actualizado viene shapeada con operator/supervisor/inUse/currentFuelLevel (contrato que exige EquipmentResponseSchema en el front)', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({
        id: 'eq_1',
        status: EquipmentStatus.IN_WORKSHOP,
        currentOperatorId: null,
        currentSupervisorId: 'user_sup',
        horometros: [],
      });
      userFindMany.mockResolvedValue([
        { id: 'user_sup', name: 'Marcela Supervisora' },
      ]);

      const result = await service.updateStatus('eq_1', {
        status: EquipmentStatus.IN_WORKSHOP,
      });

      expect(result).toMatchObject({
        operator: null,
        supervisor: { id: 'user_sup', name: 'Marcela Supervisora' },
        inUse: false,
        currentFuelLevel: null,
      });
      expect(result).not.toHaveProperty('horometros');
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

  describe('updateAssignment', () => {
    it('asigna operador y supervisor cuando ambos tienen el rol correcto', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' }); // assertExiste
      userFindUnique
        .mockResolvedValueOnce({ id: 'user_op', role: ROLES.OPERADOR })
        .mockResolvedValueOnce({ id: 'user_sup', role: ROLES.SUPERVISOR });
      update.mockResolvedValue({
        id: 'eq_1',
        currentOperatorId: 'user_op',
        currentSupervisorId: 'user_sup',
        horometros: [],
      });
      userFindMany.mockResolvedValue([
        { id: 'user_op', name: 'Juan Operador' },
        { id: 'user_sup', name: 'Marcela Supervisora' },
      ]);

      const result = await service.updateAssignment('eq_1', {
        operatorId: 'user_op',
        supervisorId: 'user_sup',
      });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { currentOperatorId: 'user_op', currentSupervisorId: 'user_sup' },
        include: EQUIPMENT_USAGE_INCLUDE,
      });
      expect(result).toMatchObject({
        operator: { id: 'user_op', name: 'Juan Operador' },
        supervisor: { id: 'user_sup', name: 'Marcela Supervisora' },
        inUse: true,
      });
    });

    it('libera operador y supervisor con null explícito', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      update.mockResolvedValue({
        id: 'eq_1',
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      const result = await service.updateAssignment('eq_1', {
        operatorId: null,
        supervisorId: null,
      });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'eq_1' },
        data: { currentOperatorId: null, currentSupervisorId: null },
        include: EQUIPMENT_USAGE_INCLUDE,
      });
      expect(result).toMatchObject({
        operator: null,
        supervisor: null,
        inUse: false,
      });
      expect(userFindUnique).not.toHaveBeenCalled();
    });

    it('un campo omitido deja esa asignación intacta', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      userFindUnique.mockResolvedValue({ id: 'user_op', role: ROLES.OPERADOR });
      update.mockResolvedValue({
        id: 'eq_1',
        currentOperatorId: 'user_op',
        currentSupervisorId: null,
        horometros: [],
      });

      await service.updateAssignment('eq_1', { operatorId: 'user_op' });

      const [{ data }] = update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).not.toHaveProperty('currentSupervisorId');
    });

    it('rechaza un operatorId de un usuario con otro rol', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      userFindUnique.mockResolvedValue({
        id: 'user_x',
        role: ROLES.MANTENEDOR,
      });

      await expect(
        service.updateAssignment('eq_1', { operatorId: 'user_x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it('rechaza un operatorId inexistente', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      userFindUnique.mockResolvedValue(null);

      await expect(
        service.updateAssignment('eq_1', { operatorId: 'missing' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza un supervisorId con rol distinto de SUPERVISOR', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      userFindUnique.mockResolvedValue({ id: 'user_x', role: ROLES.ADMIN });

      await expect(
        service.updateAssignment('eq_1', { supervisorId: 'user_x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza un operatorId baneado aunque tenga el rol OPERADOR correcto', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      userFindUnique.mockResolvedValue({
        id: 'user_baneado',
        role: ROLES.OPERADOR,
        banned: true,
      });

      await expect(
        service.updateAssignment('eq_1', { operatorId: 'user_baneado' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it('rechaza un supervisorId baneado aunque tenga el rol SUPERVISOR correcto', async () => {
      findUnique.mockResolvedValue({ id: 'eq_1' });
      userFindUnique.mockResolvedValue({
        id: 'user_baneado',
        role: ROLES.SUPERVISOR,
        banned: true,
      });

      await expect(
        service.updateAssignment('eq_1', { supervisorId: 'user_baneado' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el equipo no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.updateAssignment('missing', { operatorId: 'user_op' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('devuelve la ficha del equipo enriquecida con operator/supervisor/inUse/currentFuelLevel', async () => {
      const ficha = {
        id: 'eq_1',
        internalCode: 'EX-001',
        currentOperatorId: 'user_op',
        currentSupervisorId: null,
        horometros: [{ nivelCombustible: 90 }],
      };
      findUnique.mockResolvedValue(ficha);
      userFindMany.mockResolvedValue([
        { id: 'user_op', name: 'Juan Operador' },
      ]);

      const result = await service.findOne('eq_1');

      expect(result).toMatchObject({
        id: 'eq_1',
        internalCode: 'EX-001',
        operator: { id: 'user_op', name: 'Juan Operador' },
        supervisor: null,
        inUse: true,
        currentFuelLevel: 90,
      });
      expect(result).not.toHaveProperty('horometros');
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

    it('bloquea el borrado si el equipo solo tiene documentos asociados', async () => {
      findUnique.mockResolvedValue({
        id: 'eq_1',
        internalCode: 'EX-001',
        _count: { ...SIN_REGISTROS, documents: 1 },
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

  describe('findAll/findOne — documentsAlert', () => {
    it('resuelve documentsAlert con UNA sola consulta batch, trayendo solo documentos con expiryDate', async () => {
      findMany.mockResolvedValue([
        {
          id: 'eq_1',
          currentOperatorId: null,
          currentSupervisorId: null,
          horometros: [],
        },
        {
          id: 'eq_2',
          currentOperatorId: null,
          currentSupervisorId: null,
          horometros: [],
        },
      ]);

      await service.findAll({});

      expect(equipmentDocumentFindMany).toHaveBeenCalledTimes(1);
      expect(equipmentDocumentFindMany).toHaveBeenCalledWith({
        where: {
          equipmentId: { in: ['eq_1', 'eq_2'] },
          expiryDate: { not: null },
        },
        select: { equipmentId: true, expiryDate: true },
      });
    });

    it('no consulta documentos si no hay equipos', async () => {
      findMany.mockResolvedValue([]);

      await service.findAll({});

      expect(equipmentDocumentFindMany).not.toHaveBeenCalled();
    });

    it('documentsAlert es null cuando el equipo no tiene documentos', async () => {
      findMany.mockResolvedValue([
        {
          id: 'eq_1',
          currentOperatorId: null,
          currentSupervisorId: null,
          horometros: [],
        },
      ]);
      equipmentDocumentFindMany.mockResolvedValue([]);

      const [equipo] = await service.findAll({});

      expect(equipo).toMatchObject({ documentsAlert: null });
    });

    it('documentsAlert es POR_VENCER cuando el documento más urgente vence dentro del umbral', async () => {
      const enDiez = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
      findMany.mockResolvedValue([
        {
          id: 'eq_1',
          currentOperatorId: null,
          currentSupervisorId: null,
          horometros: [],
        },
      ]);
      equipmentDocumentFindMany.mockResolvedValue([
        { equipmentId: 'eq_1', expiryDate: enDiez },
      ]);

      const [equipo] = await service.findAll({});

      expect(equipo).toMatchObject({ documentsAlert: 'POR_VENCER' });
    });

    it('documentsAlert es VENCIDO cuando el documento más urgente ya venció', async () => {
      const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
      findMany.mockResolvedValue([
        {
          id: 'eq_1',
          currentOperatorId: null,
          currentSupervisorId: null,
          horometros: [],
        },
      ]);
      equipmentDocumentFindMany.mockResolvedValue([
        { equipmentId: 'eq_1', expiryDate: ayer },
      ]);

      const [equipo] = await service.findAll({});

      expect(equipo).toMatchObject({ documentsAlert: 'VENCIDO' });
    });

    it('VENCIDO gana sobre POR_VENCER cuando el equipo tiene varios documentos con expiryDate', async () => {
      const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const enDiez = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
      findMany.mockResolvedValue([
        {
          id: 'eq_1',
          currentOperatorId: null,
          currentSupervisorId: null,
          horometros: [],
        },
      ]);
      // Orden POR_VENCER primero, VENCIDO después — confirma que el segundo
      // "sube" la alerta en vez de que la primera iteración la deje fija.
      equipmentDocumentFindMany.mockResolvedValue([
        { equipmentId: 'eq_1', expiryDate: enDiez },
        { equipmentId: 'eq_1', expiryDate: ayer },
      ]);

      const [equipo] = await service.findAll({});

      expect(equipo).toMatchObject({ documentsAlert: 'VENCIDO' });
    });

    it('un documento VIGENTE (fuera del umbral) no dispara documentsAlert', async () => {
      const enCien = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000);
      findMany.mockResolvedValue([
        {
          id: 'eq_1',
          currentOperatorId: null,
          currentSupervisorId: null,
          horometros: [],
        },
      ]);
      equipmentDocumentFindMany.mockResolvedValue([
        { equipmentId: 'eq_1', expiryDate: enCien },
      ]);

      const [equipo] = await service.findAll({});

      expect(equipo).toMatchObject({ documentsAlert: null });
    });

    it('findOne expone documentsAlert null cuando el equipo no tiene documentos urgentes', async () => {
      findUnique.mockResolvedValue({
        id: 'eq_1',
        currentOperatorId: null,
        currentSupervisorId: null,
        horometros: [],
      });

      const result = await service.findOne('eq_1');

      expect(result).toMatchObject({ documentsAlert: null });
    });
  });
});
