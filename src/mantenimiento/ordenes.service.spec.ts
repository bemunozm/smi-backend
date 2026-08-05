import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { OrdenesService } from './ordenes.service';

const MOCK_ORDEN = {
  id: 'orden_1',
  equipoId: 'CM-003',
  asignadoAId: 'user_mantenedor',
  titulo: 'Frenos con baja respuesta',
  estado: 'PENDIENTE',
  prioridad: 'CRITICA',
  tipo: 'CORRECTIVA',
  origen: 'HALLAZGO',
  origenDetalle: 'P. Soto',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  tareas: [
    {
      id: 'tarea_1',
      texto: 'Medir espesor de balatas',
      hecha: false,
      posicion: 0,
    },
  ],
};

const MOCK_MANTENEDOR = { id: 'user_mantenedor', name: 'Mantenedor SMI' };

describe('OrdenesService', () => {
  let service: OrdenesService;
  const ordenTrabajoFindMany = jest.fn();
  const ordenTrabajoFindUnique = jest.fn();
  const ordenTrabajoCreate = jest.fn();
  const ordenTrabajoUpdate = jest.fn();
  const tareaOTFindUnique = jest.fn();
  const tareaOTUpdate = jest.fn();
  const userFindMany = jest.fn();

  beforeEach(async () => {
    ordenTrabajoFindMany.mockReset();
    ordenTrabajoFindUnique.mockReset();
    ordenTrabajoCreate.mockReset();
    ordenTrabajoUpdate.mockReset();
    tareaOTFindUnique.mockReset();
    tareaOTUpdate.mockReset();
    userFindMany.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdenesService,
        {
          provide: PrismaService,
          useValue: {
            ordenTrabajo: {
              findMany: ordenTrabajoFindMany,
              findUnique: ordenTrabajoFindUnique,
              create: ordenTrabajoCreate,
              update: ordenTrabajoUpdate,
            },
            tareaOT: {
              findUnique: tareaOTFindUnique,
              update: tareaOTUpdate,
            },
            user: { findMany: userFindMany },
          },
        },
      ],
    }).compile();

    service = module.get<OrdenesService>(OrdenesService);
  });

  it('findAll resuelve el asignado y serializa fechas a ISO', async () => {
    ordenTrabajoFindMany.mockResolvedValue([MOCK_ORDEN]);
    userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);

    const result = await service.findAll();

    expect(result).toEqual([
      {
        id: 'orden_1',
        equipoId: 'CM-003',
        titulo: 'Frenos con baja respuesta',
        estado: 'PENDIENTE',
        prioridad: 'CRITICA',
        tipo: 'CORRECTIVA',
        origen: 'HALLAZGO',
        origenDetalle: 'P. Soto',
        asignadoA: { id: 'user_mantenedor', nombre: 'Mantenedor SMI' },
        tareas: [
          {
            id: 'tarea_1',
            texto: 'Medir espesor de balatas',
            hecha: false,
            posicion: 0,
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });

  it('findAll filtra por estado cuando se provee', async () => {
    ordenTrabajoFindMany.mockResolvedValue([]);
    userFindMany.mockResolvedValue([]);

    await service.findAll('COMPLETADA');

    expect(ordenTrabajoFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { estado: 'COMPLETADA' } }),
    );
  });

  it('findOne lanza NotFoundException si la orden no existe', async () => {
    ordenTrabajoFindUnique.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('findOne devuelve asignadoA: null cuando no hay asignado', async () => {
    ordenTrabajoFindUnique.mockResolvedValue({
      ...MOCK_ORDEN,
      asignadoAId: null,
    });
    userFindMany.mockResolvedValue([]);

    const result = await service.findOne('orden_1');

    expect(result.asignadoA).toBeNull();
  });

  it('toggleTarea lanza NotFoundException si la tarea no pertenece a la orden', async () => {
    tareaOTFindUnique.mockResolvedValue({
      id: 'tarea_1',
      ordenId: 'otra_orden',
    });

    await expect(
      service.toggleTarea('orden_1', 'tarea_1', true),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tareaOTUpdate).not.toHaveBeenCalled();
  });

  it('toggleTarea actualiza `hecha` cuando la tarea pertenece a la orden', async () => {
    tareaOTFindUnique.mockResolvedValue({ id: 'tarea_1', ordenId: 'orden_1' });
    tareaOTUpdate.mockResolvedValue({
      id: 'tarea_1',
      texto: 'Medir espesor de balatas',
      hecha: true,
      posicion: 0,
    });

    const result = await service.toggleTarea('orden_1', 'tarea_1', true);

    expect(tareaOTUpdate).toHaveBeenCalledWith({
      where: { id: 'tarea_1' },
      data: { hecha: true },
      select: { id: true, texto: true, hecha: true, posicion: true },
    });
    expect(result.hecha).toBe(true);
  });
});
