import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { ERROR_CODES } from '../common/errors/error-codes';
import { PrismaService } from '../common/prisma/prisma.service';
import { ActividadesService } from './actividades.service';

const MOCK_ACTIVIDAD = {
  id: 'actividad_1',
  descripcion: 'Verificar torque de pernos de oruga en EX-001',
  origen: 'EQUIPO',
  referencia: 'EX-001',
  asignadoAId: 'user_mantenedor',
  equipoId: 'EX-001',
  hallazgoId: null,
  estado: 'PENDIENTE',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

describe('ActividadesService', () => {
  let service: ActividadesService;
  const findMany = jest.fn();
  const findUnique = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const userFindMany = jest.fn();
  const queryRaw = jest.fn();

  beforeEach(async () => {
    queryRaw.mockReset();
    findMany.mockReset();
    findUnique.mockReset();
    create.mockReset();
    update.mockReset();
    userFindMany.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActividadesService,
        {
          provide: PrismaService,
          useValue: {
            actividad: { findMany, findUnique, create, update },
            user: { findMany: userFindMany },
            $queryRaw: queryRaw,
            $transaction: (fn: (tx: unknown) => unknown) =>
              fn({
                actividad: { findUnique, update },
                $queryRaw: queryRaw,
              }),
          },
        },
      ],
    }).compile();

    service = module.get<ActividadesService>(ActividadesService);
  });

  it('findAll resuelve asignadoA y serializa fechas a ISO', async () => {
    findMany.mockResolvedValue([MOCK_ACTIVIDAD]);
    userFindMany.mockResolvedValue([
      { id: 'user_mantenedor', name: 'Mantenedor SMI' },
    ]);

    const result = await service.findAll();

    expect(result).toEqual([
      {
        id: 'actividad_1',
        descripcion: 'Verificar torque de pernos de oruga en EX-001',
        origen: 'EQUIPO',
        referencia: 'EX-001',
        asignadoA: { id: 'user_mantenedor', nombre: 'Mantenedor SMI' },
        equipoId: 'EX-001',
        hallazgoId: null,
        estado: 'PENDIENTE',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });

  it('update lanza NotFoundException si la actividad no existe', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      service.update('missing', { estado: 'COMPLETADA' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it('update cambia el estado y devuelve la actividad mapeada', async () => {
    findUnique.mockResolvedValue(MOCK_ACTIVIDAD);
    update.mockResolvedValue({ ...MOCK_ACTIVIDAD, estado: 'COMPLETADA' });
    userFindMany.mockResolvedValue([
      { id: 'user_mantenedor', name: 'Mantenedor SMI' },
    ]);

    const result = await service.update('actividad_1', {
      estado: 'COMPLETADA',
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'actividad_1' },
      data: { estado: 'COMPLETADA' },
      select: {
        id: true,
        descripcion: true,
        origen: true,
        referencia: true,
        asignadoAId: true,
        equipoId: true,
        hallazgoId: true,
        estado: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    expect(result.estado).toBe('COMPLETADA');
  });

  describe('create con id del cliente (reintento offline)', () => {
    const ID = '11111111-1111-4111-8111-111111111111';
    const dto = {
      id: ID,
      descripcion: 'Verificar torque',
      origen: 'EQUIPO' as const,
    };

    it('replay del mismo usuario: devuelve la actividad sin crear otra', async () => {
      findUnique.mockResolvedValue({
        ...MOCK_ACTIVIDAD,
        id: ID,
        createdById: 'u1',
      });
      userFindMany.mockResolvedValue([]);

      const result = await service.create(dto, 'u1');

      expect(result.id).toBe(ID);
      expect(result).not.toHaveProperty('createdById');
      expect(create).not.toHaveBeenCalled();
    });

    it('id ocupado por otro usuario: 409 ID_CONFLICT', async () => {
      findUnique.mockResolvedValue({
        ...MOCK_ACTIVIDAD,
        id: ID,
        createdById: 'otro',
      });

      await expect(service.create(dto, 'u1')).rejects.toMatchObject({
        response: { code: ERROR_CODES.ID_CONFLICT },
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('crea con el id del cliente y el dueño', async () => {
      findUnique.mockResolvedValue(null);
      create.mockResolvedValue({ ...MOCK_ACTIVIDAD, id: ID });
      userFindMany.mockResolvedValue([]);

      await service.create(dto, 'u1');

      const [{ data }] = create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toMatchObject({ id: ID, createdById: 'u1' });
    });
  });

  describe('update con X-Expected', () => {
    beforeEach(() => {
      queryRaw.mockResolvedValue([{ id: 'actividad_1' }]);
      userFindMany.mockResolvedValue([]);
    });

    it('si otro cambió el estado: 409 STALE_UPDATE y no escribe', async () => {
      findUnique
        .mockResolvedValueOnce(MOCK_ACTIVIDAD)
        .mockResolvedValueOnce({ estado: 'CANCELADA' });

      await expect(
        service.update(
          'actividad_1',
          { estado: 'COMPLETADA' },
          { estado: 'PENDIENTE' },
        ),
      ).rejects.toMatchObject({
        response: { code: ERROR_CODES.STALE_UPDATE },
      });
      expect(update).not.toHaveBeenCalled();
    });

    it('con el estado vigente escribe bajo bloqueo', async () => {
      findUnique
        .mockResolvedValueOnce(MOCK_ACTIVIDAD)
        .mockResolvedValueOnce({ estado: 'PENDIENTE' });
      update.mockResolvedValue({ ...MOCK_ACTIVIDAD, estado: 'COMPLETADA' });

      await service.update(
        'actividad_1',
        { estado: 'COMPLETADA' },
        { estado: 'PENDIENTE' },
      );

      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);
    });
  });
});
