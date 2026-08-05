import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

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

  beforeEach(async () => {
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
});
