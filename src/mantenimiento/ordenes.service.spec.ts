import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ERROR_CODES } from '../common/errors/error-codes';
import { PrismaService } from '../common/prisma/prisma.service';
import { DOMAIN_EVENTS } from '../common/events/domain-events';
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
  const emit = jest.fn();
  const queryRaw = jest.fn();

  beforeEach(async () => {
    ordenTrabajoFindMany.mockReset();
    ordenTrabajoFindUnique.mockReset();
    ordenTrabajoCreate.mockReset();
    ordenTrabajoUpdate.mockReset();
    tareaOTFindUnique.mockReset();
    tareaOTUpdate.mockReset();
    userFindMany.mockReset();
    emit.mockReset();
    queryRaw.mockReset();

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
            // Con `X-Expected` la escritura va en una transacción que bloquea
            // la fila: el mock ejecuta el callback con el mismo cliente.
            $queryRaw: queryRaw,
            $transaction: (fn: (tx: unknown) => unknown) =>
              fn({
                ordenTrabajo: {
                  findUnique: ordenTrabajoFindUnique,
                  update: ordenTrabajoUpdate,
                },
                $queryRaw: queryRaw,
              }),
          },
        },
        { provide: EventEmitter2, useValue: { emit } },
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

  describe('update — eventos de dominio', () => {
    it('emite ORDEN_ASSIGNED cuando la orden pasa a ASIGNADA', async () => {
      ordenTrabajoFindUnique.mockResolvedValue({
        ...MOCK_ORDEN,
        estado: 'PENDIENTE',
      });
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_ORDEN,
        estado: 'ASIGNADA',
      });
      userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);

      await service.update('orden_1', {
        estado: 'ASIGNADA',
        asignadoAId: 'user_mantenedor',
      } as never);

      expect(emit).toHaveBeenCalledWith(DOMAIN_EVENTS.ORDEN_ASSIGNED, {
        ordenId: 'orden_1',
        equipoId: 'CM-003',
        asignadoId: 'user_mantenedor',
        titulo: 'Frenos con baja respuesta',
      });
    });

    it('emite ORDEN_COMPLETED cuando la orden pasa a COMPLETADA', async () => {
      ordenTrabajoFindUnique.mockResolvedValue({
        ...MOCK_ORDEN,
        estado: 'EN_PROCESO',
      });
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_ORDEN,
        estado: 'COMPLETADA',
      });
      userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);

      await service.update('orden_1', { estado: 'COMPLETADA' } as never);

      expect(emit).toHaveBeenCalledWith(DOMAIN_EVENTS.ORDEN_COMPLETED, {
        ordenId: 'orden_1',
        equipoId: 'CM-003',
        titulo: 'Frenos con baja respuesta',
      });
    });

    it('no emite nada si el estado no cambia', async () => {
      ordenTrabajoFindUnique.mockResolvedValue({
        ...MOCK_ORDEN,
        estado: 'PENDIENTE',
      });
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_ORDEN,
        estado: 'PENDIENTE',
        titulo: 'Título editado',
      });
      userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);

      await service.update('orden_1', {
        titulo: 'Título editado',
      });

      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('create con id del cliente (reintento offline)', () => {
    const ID = '11111111-1111-4111-8111-111111111111';
    const dto = {
      id: ID,
      equipoId: 'CM-003',
      titulo: 'Frenos con baja respuesta',
      tareas: [{ texto: 'Medir espesor de balatas' }],
    };

    it('replay del mismo usuario: devuelve la orden sin crear otra', async () => {
      ordenTrabajoFindUnique
        .mockResolvedValueOnce({ createdById: 'u1' })
        .mockResolvedValueOnce({ ...MOCK_ORDEN, id: ID });
      userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);

      const result = await service.create(dto, 'u1');

      expect(result.id).toBe(ID);
      expect(ordenTrabajoCreate).not.toHaveBeenCalled();
    });

    it('id ocupado por otro usuario: 409 ID_CONFLICT', async () => {
      ordenTrabajoFindUnique.mockResolvedValueOnce({ createdById: 'otro' });

      await expect(service.create(dto, 'u1')).rejects.toMatchObject({
        response: { code: ERROR_CODES.ID_CONFLICT },
      });
      expect(ordenTrabajoCreate).not.toHaveBeenCalled();
    });

    it('crea con el id del cliente y el dueño', async () => {
      ordenTrabajoFindUnique.mockResolvedValueOnce(null);
      ordenTrabajoCreate.mockResolvedValue({ ...MOCK_ORDEN, id: ID });
      userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);

      await service.create(dto, 'u1');

      const [{ data }] = ordenTrabajoCreate.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toMatchObject({ id: ID, createdById: 'u1' });
    });
  });

  describe('update con X-Expected', () => {
    beforeEach(() => {
      queryRaw.mockResolvedValue([{ id: 'orden_1' }]);
      userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);
    });

    it('si otro cambió el estado: 409 STALE_UPDATE, no escribe y no emite', async () => {
      ordenTrabajoFindUnique
        .mockResolvedValueOnce({ ...MOCK_ORDEN, estado: 'PENDIENTE' })
        .mockResolvedValueOnce({
          estado: 'CANCELADA',
          asignadoAId: null,
          prioridad: 'CRITICA',
          titulo: 'Frenos con baja respuesta',
        });

      await expect(
        service.update(
          'orden_1',
          { estado: 'COMPLETADA' },
          { estado: 'PENDIENTE' },
        ),
      ).rejects.toMatchObject({
        response: { code: ERROR_CODES.STALE_UPDATE },
      });
      expect(ordenTrabajoUpdate).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('la transición se evalúa contra el estado bajo bloqueo y el evento sale tras confirmar', async () => {
      ordenTrabajoFindUnique
        .mockResolvedValueOnce({ ...MOCK_ORDEN, estado: 'PENDIENTE' })
        .mockResolvedValueOnce({
          estado: 'PENDIENTE',
          asignadoAId: 'user_mantenedor',
          prioridad: 'CRITICA',
          titulo: 'Frenos con baja respuesta',
        });
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_ORDEN,
        estado: 'COMPLETADA',
      });

      await service.update(
        'orden_1',
        { estado: 'COMPLETADA' },
        { estado: 'PENDIENTE' },
      );

      expect(emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.ORDEN_COMPLETED,
        expect.objectContaining({ ordenId: 'orden_1' }),
      );
    });

    it('el reintento de una edición ya aplicada pasa sin emitir de nuevo', async () => {
      ordenTrabajoFindUnique
        .mockResolvedValueOnce({ ...MOCK_ORDEN, estado: 'COMPLETADA' })
        .mockResolvedValueOnce({
          estado: 'COMPLETADA',
          asignadoAId: 'user_mantenedor',
          prioridad: 'CRITICA',
          titulo: 'Frenos con baja respuesta',
        });
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_ORDEN,
        estado: 'COMPLETADA',
      });

      await service.update(
        'orden_1',
        { estado: 'COMPLETADA' },
        { estado: 'PENDIENTE' },
      );

      expect(emit).not.toHaveBeenCalled();
    });

    it('si la escritura falla dentro de la transacción no se emite nada', async () => {
      ordenTrabajoFindUnique
        .mockResolvedValueOnce({ ...MOCK_ORDEN, estado: 'PENDIENTE' })
        .mockResolvedValueOnce({
          estado: 'PENDIENTE',
          asignadoAId: 'user_mantenedor',
          prioridad: 'CRITICA',
          titulo: 'Frenos con baja respuesta',
        });
      ordenTrabajoUpdate.mockRejectedValue(new Error('boom'));

      await expect(
        service.update(
          'orden_1',
          { estado: 'COMPLETADA' },
          { estado: 'PENDIENTE' },
        ),
      ).rejects.toThrow('boom');
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
