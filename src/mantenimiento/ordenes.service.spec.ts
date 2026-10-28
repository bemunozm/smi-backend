import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ERROR_CODES } from '../common/errors/error-codes';
import { PrismaService } from '../common/prisma/prisma.service';
import { StockService } from '../inventory/stock.service';
import { StorageService } from '../storage/storage.service';
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
  pautaMilestone: null,
  pautaCycle: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  tareas: [
    {
      id: 'tarea_1',
      texto: 'Medir espesor de balatas',
      hecha: false,
      posicion: 0,
      planItemId: null,
      notas: null,
      fotoKey: null,
      hechaPorNombre: null,
      hechaAt: null,
    },
  ],
};

/** Orden PREVENTIVA nacida de la pauta — la tarjeta-checklist del tablero. */
const MOCK_PREVENTIVA = {
  ...MOCK_ORDEN,
  id: 'orden_prev',
  tipo: 'PREVENTIVA',
  origen: 'PREVENTIVO',
  origenDetalle: 'Pauta: 250 h · ciclo 1',
  pautaMilestone: 250,
  pautaCycle: 1,
  tareas: [
    {
      id: 'tarea_a',
      texto: 'Cambio de aceite',
      hecha: false,
      posicion: 0,
      planItemId: 'item_a',
      notas: null,
      fotoKey: null,
      hechaPorNombre: null,
      hechaAt: null,
    },
    {
      id: 'tarea_b',
      texto: 'Cambio de filtro',
      hecha: false,
      posicion: 1,
      planItemId: 'item_b',
      notas: null,
      fotoKey: null,
      hechaPorNombre: null,
      hechaAt: null,
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
  const tareaOTFindMany = jest.fn();
  const recordUpsert = jest.fn();
  const recordDeleteMany = jest.fn();
  const planItemFindUnique = jest.fn();
  const equipmentFindUnique = jest.fn();
  const claimTmp = jest.fn();
  const sign = jest.fn();
  const discard = jest.fn();
  const stockIssue = jest.fn();
  const emitPending = jest.fn();
  const hallazgoFindUnique = jest.fn();
  const hallazgoUpdate = jest.fn();
  const hallazgoUpdateMany = jest.fn();
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
    tareaOTFindMany.mockReset();
    recordUpsert.mockReset();
    recordDeleteMany.mockReset();
    planItemFindUnique.mockReset();
    planItemFindUnique.mockResolvedValue({
      description: 'Cambio de aceite',
      kind: 'LUBRICANTE',
    });
    equipmentFindUnique.mockReset();
    equipmentFindUnique.mockResolvedValue({
      id: 'eq_flota_1',
      controlUnit: 'HOURS',
      currentHourmeter: 245,
      currentMileage: null,
    });
    stockIssue.mockReset();
    emitPending.mockReset();
    claimTmp.mockReset();
    claimTmp.mockImplementation((key: string) =>
      Promise.resolve(`claimed/${key}`),
    );
    sign.mockReset();
    sign.mockImplementation((key: string) =>
      Promise.resolve(`https://signed/${key}`),
    );
    discard.mockReset();
    hallazgoFindUnique.mockReset();
    hallazgoUpdate.mockReset();
    hallazgoUpdateMany.mockReset();
    // El claim condicional "encuentra y toma" por defecto; cada test de
    // carrera lo pisa con `count: 0`.
    hallazgoUpdateMany.mockResolvedValue({ count: 1 });
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
            hallazgo: {
              findUnique: hallazgoFindUnique,
              update: hallazgoUpdate,
              updateMany: hallazgoUpdateMany,
            },
            user: { findMany: userFindMany },
            // `resolveEquipmentId` corre fuera de la transacción.
            equipment: { findUnique: equipmentFindUnique },
            // Con `X-Expected` la escritura va en una transacción que bloquea
            // la fila: el mock ejecuta el callback con el mismo cliente.
            $queryRaw: queryRaw,
            $transaction: (fn: (tx: unknown) => unknown) =>
              fn({
                ordenTrabajo: {
                  findUnique: ordenTrabajoFindUnique,
                  create: ordenTrabajoCreate,
                  update: ordenTrabajoUpdate,
                },
                hallazgo: {
                  findUnique: hallazgoFindUnique,
                  update: hallazgoUpdate,
                  updateMany: hallazgoUpdateMany,
                },
                tareaOT: {
                  update: tareaOTUpdate,
                  findMany: tareaOTFindMany,
                },
                maintenanceRecord: {
                  upsert: recordUpsert,
                  deleteMany: recordDeleteMany,
                },
                maintenancePlanItem: { findUnique: planItemFindUnique },
                equipment: { findUnique: equipmentFindUnique },
                $queryRaw: queryRaw,
              }),
          },
        },
        { provide: StorageService, useValue: { claimTmp, sign, discard } },
        { provide: StockService, useValue: { issue: stockIssue, emitPending } },
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
        pautaMilestone: null,
        pautaCycle: null,
        asignadoA: { id: 'user_mantenedor', nombre: 'Mantenedor SMI' },
        tareas: [
          {
            id: 'tarea_1',
            texto: 'Medir espesor de balatas',
            hecha: false,
            posicion: 0,
            notas: null,
            fotoUrl: null,
            hechaPorNombre: null,
            hechaAt: null,
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

  describe('updateTarea', () => {
    const EDITOR = { id: 'user_mantenedor', name: 'Mantenedor SMI' };
    const TAREA_HECHA = {
      id: 'tarea_a',
      texto: 'Cambio de aceite',
      hecha: true,
      posicion: 0,
      notas: 'Aceite 15W-40 nuevo',
      fotoKey: null,
    };

    it('lanza NotFoundException si la tarea no pertenece a la orden', async () => {
      tareaOTFindUnique.mockResolvedValue({
        id: 'tarea_1',
        ordenId: 'otra_orden',
        planItemId: null,
        texto: 'x',
      });

      await expect(
        service.updateTarea('orden_1', 'tarea_1', { hecha: true }, EDITOR),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tareaOTUpdate).not.toHaveBeenCalled();
    });

    it('en una orden corriente actualiza la tarea sin tocar estado ni registro del ciclo', async () => {
      tareaOTFindUnique.mockResolvedValue({
        id: 'tarea_1',
        ordenId: 'orden_1',
        planItemId: null,
        texto: 'Medir espesor de balatas',
      });
      ordenTrabajoFindUnique.mockResolvedValue(MOCK_ORDEN);
      tareaOTUpdate.mockResolvedValue({ ...MOCK_ORDEN.tareas[0], hecha: true });

      const result = await service.updateTarea(
        'orden_1',
        'tarea_1',
        { hecha: true },
        EDITOR,
      );

      expect(result.hecha).toBe(true);
      expect(recordUpsert).not.toHaveBeenCalled();
      expect(ordenTrabajoUpdate).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('preventiva: marcar guarda notas/foto, escribe el registro del ciclo y pasa a EN_PROCESO', async () => {
      tareaOTFindUnique.mockResolvedValue({
        id: 'tarea_a',
        ordenId: 'orden_prev',
        planItemId: 'item_a',
        texto: 'Cambio de aceite',
      });
      ordenTrabajoFindUnique.mockResolvedValue(MOCK_PREVENTIVA);
      tareaOTUpdate.mockResolvedValue({
        ...TAREA_HECHA,
        fotoKey: 'claimed/tmp/foto.jpg',
      });
      // Queda una pendiente: la orden va a EN_PROCESO, no a COMPLETADA.
      tareaOTFindMany.mockResolvedValue([{ hecha: true }, { hecha: false }]);
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_PREVENTIVA,
        estado: 'EN_PROCESO',
      });

      const result = await service.updateTarea(
        'orden_prev',
        'tarea_a',
        { hecha: true, notas: 'Aceite 15W-40 nuevo', fotoKey: 'tmp/foto.jpg' },
        EDITOR,
      );

      expect(claimTmp).toHaveBeenCalledWith(
        'tmp/foto.jpg',
        EDITOR.id,
        'tarea-photo',
      );
      expect(tareaOTUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            hecha: true,
            notas: 'Aceite 15W-40 nuevo',
            fotoKey: 'claimed/tmp/foto.jpg',
            // El "ver detalle": quién y cuándo quedan en la tarea.
            hechaPorNombre: EDITOR.name,
          }),
        }),
      );
      expect(recordUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            planItemId_cycle_milestone: {
              planItemId: 'item_a',
              cycle: 1,
              milestone: 250,
            },
          },
          create: expect.objectContaining({
            equipmentId: MOCK_PREVENTIVA.equipoId,
            counterAt: 245,
            doneByName: EDITOR.name,
          }),
          update: {},
        }),
      );
      expect(ordenTrabajoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: { estado: 'EN_PROCESO' } }),
      );
      // La respuesta firma la foto, nunca expone la key.
      expect(result.fotoUrl).toBe('https://signed/claimed/tmp/foto.jpg');
    });

    it('preventiva: con TODAS las tareas hechas la orden pasa sola a COMPLETADA y avisa', async () => {
      tareaOTFindUnique.mockResolvedValue({
        id: 'tarea_b',
        ordenId: 'orden_prev',
        planItemId: 'item_b',
        texto: 'Cambio de filtro',
      });
      ordenTrabajoFindUnique.mockResolvedValue(MOCK_PREVENTIVA);
      tareaOTUpdate.mockResolvedValue({ ...TAREA_HECHA, id: 'tarea_b' });
      tareaOTFindMany.mockResolvedValue([{ hecha: true }, { hecha: true }]);
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_PREVENTIVA,
        estado: 'COMPLETADA',
      });

      await service.updateTarea(
        'orden_prev',
        'tarea_b',
        { hecha: true, notas: 'ok' },
        EDITOR,
      );

      expect(ordenTrabajoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: { estado: 'COMPLETADA' } }),
      );
      expect(emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.ORDEN_COMPLETED,
        expect.objectContaining({ ordenId: 'orden_prev' }),
      );
    });

    it('preventiva: desmarcar borra el registro del ciclo y no inventa transiciones', async () => {
      tareaOTFindUnique.mockResolvedValue({
        id: 'tarea_a',
        ordenId: 'orden_prev',
        planItemId: 'item_a',
        texto: 'Cambio de aceite',
      });
      ordenTrabajoFindUnique.mockResolvedValue({
        ...MOCK_PREVENTIVA,
        estado: 'EN_PROCESO',
      });
      tareaOTUpdate.mockResolvedValue({ ...TAREA_HECHA, hecha: false });
      tareaOTFindMany.mockResolvedValue([{ hecha: false }, { hecha: false }]);

      await service.updateTarea(
        'orden_prev',
        'tarea_a',
        { hecha: false },
        EDITOR,
      );

      expect(recordDeleteMany).toHaveBeenCalledWith({
        where: { planItemId: 'item_a', cycle: 1, milestone: 250 },
      });
      expect(ordenTrabajoUpdate).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('los insumos de la tarea se descuentan del stock en la MISMA transacción', async () => {
      tareaOTFindUnique.mockResolvedValue({
        id: 'tarea_a',
        ordenId: 'orden_prev',
        planItemId: 'item_a',
        texto: 'Cambio de aceite',
      });
      ordenTrabajoFindUnique.mockResolvedValue(MOCK_PREVENTIVA);
      tareaOTUpdate.mockResolvedValue(TAREA_HECHA);
      tareaOTFindMany.mockResolvedValue([{ hecha: true }, { hecha: false }]);
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_PREVENTIVA,
        estado: 'EN_PROCESO',
      });

      await service.updateTarea(
        'orden_prev',
        'tarea_a',
        {
          hecha: true,
          notas: 'ok',
          branchId: 'br_faena',
          insumos: [{ insumoId: 'item_aceite', cantidad: 2 }],
        },
        EDITOR,
      );

      expect(stockIssue).toHaveBeenCalledWith(
        {
          itemId: 'item_aceite',
          branchId: 'br_faena',
          quantity: 2,
          reason: 'INTERVENTION',
          performedById: EDITOR.id,
          // `equipoId` de la OT resuelto contra Flota.
          equipmentId: 'eq_flota_1',
          reference: 'orden_prev',
        },
        expect.objectContaining({ events: expect.any(Array) }),
      );
      // Los avisos de stock bajo salen SOLO tras confirmar la transacción.
      expect(emitPending).toHaveBeenCalledTimes(1);
    });

    it('insumos sin bodega: rechaza antes de tocar nada', async () => {
      tareaOTFindUnique.mockResolvedValue({
        id: 'tarea_a',
        ordenId: 'orden_prev',
        planItemId: 'item_a',
        texto: 'Cambio de aceite',
      });
      ordenTrabajoFindUnique.mockResolvedValue(MOCK_PREVENTIVA);

      await expect(
        service.updateTarea(
          'orden_prev',
          'tarea_a',
          { hecha: true, insumos: [{ insumoId: 'item_aceite', cantidad: 2 }] },
          EDITOR,
        ),
      ).rejects.toThrow('Indica la bodega');
      expect(tareaOTUpdate).not.toHaveBeenCalled();
      expect(stockIssue).not.toHaveBeenCalled();
    });

    it('si la transacción falla, la foto reclamada se descarta', async () => {
      tareaOTFindUnique.mockResolvedValue({
        id: 'tarea_a',
        ordenId: 'orden_prev',
        planItemId: 'item_a',
        texto: 'Cambio de aceite',
      });
      ordenTrabajoFindUnique.mockResolvedValue(MOCK_PREVENTIVA);
      tareaOTUpdate.mockRejectedValue(new Error('db caída'));

      await expect(
        service.updateTarea(
          'orden_prev',
          'tarea_a',
          { hecha: true, fotoKey: 'tmp/foto.jpg' },
          EDITOR,
        ),
      ).rejects.toThrow('db caída');
      expect(discard).toHaveBeenCalledWith('claimed/tmp/foto.jpg');
    });
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

  describe('orden ligada a un hallazgo (taller)', () => {
    const CREATE_DTO = {
      equipoId: 'CM-003',
      titulo: 'Reparación de frenos',
      prioridad: 'CRITICA' as const,
      tipo: 'CORRECTIVA' as const,
      origen: 'HALLAZGO' as const,
      hallazgoId: 'hallazgo_1',
    };

    it('create con hallazgoId toma el hallazgo con un claim CONDICIONAL atómico', async () => {
      hallazgoFindUnique.mockResolvedValue({
        id: 'hallazgo_1',
        estado: 'ABIERTO',
      });
      ordenTrabajoCreate.mockResolvedValue({
        ...MOCK_ORDEN,
        hallazgoId: 'hallazgo_1',
      });
      userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);

      const result = await service.create(CREATE_DTO, 'user_1');

      expect(result.hallazgoId).toBe('hallazgo_1');
      // updateMany con la condición de estado: dos claims concurrentes no
      // pueden ganar los dos (el segundo ve count: 0).
      expect(hallazgoUpdateMany).toHaveBeenCalledWith({
        where: { id: 'hallazgo_1', estado: 'ABIERTO' },
        data: { estado: 'EN_PROCESO' },
      });
    });

    it('create con hallazgo que no está ABIERTO: 409 y no crea la orden', async () => {
      hallazgoFindUnique.mockResolvedValue({
        id: 'hallazgo_1',
        estado: 'EN_PROCESO',
      });
      hallazgoUpdateMany.mockResolvedValue({ count: 0 });

      await expect(service.create(CREATE_DTO, 'user_1')).rejects.toThrow(
        'El hallazgo ya está en proceso o cerrado',
      );
      expect(ordenTrabajoCreate).not.toHaveBeenCalled();
    });

    it('carrera: el hallazgo se veía ABIERTO pero otro lo tomó primero → 409, sin OT duplicada', async () => {
      // El findUnique del 404 lo vio ABIERTO, pero entre medio otro create ganó
      // el claim: updateMany devuelve count 0 y este create pierde limpio.
      hallazgoFindUnique.mockResolvedValue({
        id: 'hallazgo_1',
        estado: 'ABIERTO',
      });
      hallazgoUpdateMany.mockResolvedValue({ count: 0 });

      await expect(service.create(CREATE_DTO, 'user_1')).rejects.toThrow(
        'El hallazgo ya está en proceso o cerrado',
      );
      expect(ordenTrabajoCreate).not.toHaveBeenCalled();
    });

    it('create con hallazgo inexistente: 404', async () => {
      hallazgoFindUnique.mockResolvedValue(null);

      await expect(service.create(CREATE_DTO, 'user_1')).rejects.toThrow(
        NotFoundException,
      );
      expect(ordenTrabajoCreate).not.toHaveBeenCalled();
    });

    it('update a COMPLETADA cierra el hallazgo ligado', async () => {
      const enProceso = {
        ...MOCK_ORDEN,
        estado: 'EN_PROCESO',
        hallazgoId: 'hallazgo_1',
      };
      ordenTrabajoFindUnique.mockResolvedValue(enProceso);
      ordenTrabajoUpdate.mockResolvedValue({
        ...enProceso,
        estado: 'COMPLETADA',
      });
      userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);

      await service.update('orden_1', { estado: 'COMPLETADA' });

      // Condicionado a EN_PROCESO: no pisa un cierre manual del supervisor.
      expect(hallazgoUpdateMany).toHaveBeenCalledWith({
        where: { id: 'hallazgo_1', estado: 'EN_PROCESO' },
        data: { estado: 'CERRADO' },
      });
    });

    it('update a CANCELADA devuelve el hallazgo a ABIERTO (vuelve a la bandeja)', async () => {
      const enProceso = {
        ...MOCK_ORDEN,
        estado: 'EN_PROCESO',
        hallazgoId: 'hallazgo_1',
      };
      ordenTrabajoFindUnique.mockResolvedValue(enProceso);
      ordenTrabajoUpdate.mockResolvedValue({
        ...enProceso,
        estado: 'CANCELADA',
      });
      userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);

      await service.update('orden_1', { estado: 'CANCELADA' });

      expect(hallazgoUpdateMany).toHaveBeenCalledWith({
        where: { id: 'hallazgo_1', estado: 'EN_PROCESO' },
        data: { estado: 'ABIERTO' },
      });
    });

    it('update sin cruce de estado no toca el hallazgo', async () => {
      const enProceso = {
        ...MOCK_ORDEN,
        estado: 'EN_PROCESO',
        hallazgoId: 'hallazgo_1',
      };
      ordenTrabajoFindUnique.mockResolvedValue(enProceso);
      ordenTrabajoUpdate.mockResolvedValue({
        ...enProceso,
        titulo: 'Otro título',
      });
      userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);

      await service.update('orden_1', { titulo: 'Otro título' });

      expect(hallazgoUpdate).not.toHaveBeenCalled();
      expect(hallazgoUpdateMany).not.toHaveBeenCalled();
    });
  });
});
