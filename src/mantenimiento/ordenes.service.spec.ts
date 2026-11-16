import { BadRequestException, NotFoundException } from '@nestjs/common';
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
  const recordFindMany = jest.fn();
  const recordUpdateMany = jest.fn();
  const recordCreate = jest.fn();
  const recordCount = jest.fn();
  const recordCreateMany = jest.fn();
  const planItemFindMany = jest.fn();
  const planFindUnique = jest.fn();
  const planItemFindUnique = jest.fn();
  const equipmentFindUnique = jest.fn();
  const equipmentUpdate = jest.fn();
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
    // Sin mantenciones anteriores con contador: nada contra qué validar.
    recordFindMany.mockReset();
    recordFindMany.mockResolvedValue([]);
    recordUpdateMany.mockReset();
    recordUpdateMany.mockResolvedValue({ count: 2 });
    recordCreate.mockReset();
    recordCount.mockReset();
    recordCount.mockResolvedValue(0);
    recordCreateMany.mockReset();
    planItemFindMany.mockReset();
    planItemFindMany.mockResolvedValue([]);
    planFindUnique.mockReset();
    planFindUnique.mockResolvedValue(null);
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
    equipmentUpdate.mockReset();
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
    // `update` bloquea siempre la fila (`SELECT ... FOR UPDATE`): existe.
    queryRaw.mockResolvedValue([{ id: 'orden_1' }]);

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
            equipment: {
              findUnique: equipmentFindUnique,
              update: equipmentUpdate,
            },
            // La lectura del cierre se valida antes de abrir la transacción.
            maintenanceRecord: { findMany: recordFindMany },
            maintenancePlan: { findUnique: planFindUnique },
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
                  findMany: recordFindMany,
                  updateMany: recordUpdateMany,
                  create: recordCreate,
                  count: recordCount,
                  createMany: recordCreateMany,
                },
                maintenancePlanItem: {
                  findUnique: planItemFindUnique,
                  findMany: planItemFindMany,
                },
                maintenancePlan: { findUnique: planFindUnique },
                equipment: {
                  findUnique: equipmentFindUnique,
                  update: equipmentUpdate,
                },
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

      await service.update(
        'orden_1',
        {
          estado: 'ASIGNADA',
          asignadoAId: 'user_mantenedor',
        } as never,
        MOCK_MANTENEDOR,
      );

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

      await service.update(
        'orden_1',
        { estado: 'COMPLETADA' } as never,
        MOCK_MANTENEDOR,
      );

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

      await service.update(
        'orden_1',
        {
          titulo: 'Título editado',
        },
        MOCK_MANTENEDOR,
      );

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

  describe('createHistorica (mantención anterior)', () => {
    const DTO = {
      equipoId: 'eq_1',
      fecha: '2025-06-15',
      titulo: 'Mantención 10.000 km',
    };
    const MOCK_HISTORICA = {
      ...MOCK_ORDEN,
      id: 'orden_hist',
      estado: 'COMPLETADA',
      tipo: 'PREVENTIVA',
      origen: 'MANUAL',
      titulo: DTO.titulo,
      asignadoAId: null,
      tareas: [
        {
          ...MOCK_ORDEN.tareas[0],
          texto: DTO.titulo,
          hecha: true,
          hechaAt: new Date('2025-06-15T12:00:00.000Z'),
        },
      ],
    };

    it('crea una OT COMPLETADA con la tarea hecha en la fecha declarada y el código interno del equipo', async () => {
      equipmentFindUnique.mockResolvedValueOnce({
        internalCode: 'CM-003',
        controlUnit: 'HOURS',
      });
      ordenTrabajoCreate.mockResolvedValue(MOCK_HISTORICA);
      userFindMany.mockResolvedValue([]);

      const result = await service.createHistorica(DTO, 'u_admin');

      const [{ data }] = ordenTrabajoCreate.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toMatchObject({
        createdById: 'u_admin',
        equipoId: 'CM-003',
        titulo: DTO.titulo,
        estado: 'COMPLETADA',
        tipo: 'PREVENTIVA',
        origen: 'MANUAL',
      });
      // Mediodía UTC, no medianoche: en hora de Chile una medianoche UTC se
      // mostraría como el día anterior.
      expect(data.tareas).toEqual({
        create: [
          {
            texto: DTO.titulo,
            hecha: true,
            posicion: 0,
            hechaAt: new Date('2025-06-15T12:00:00.000Z'),
            hechaPorNombre: null,
            notas: null,
          },
        ],
      });
      expect(result.estado).toBe('COMPLETADA');
    });

    it('acepta el código interno como equipoId (segunda búsqueda)', async () => {
      equipmentFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
        internalCode: 'CM-003',
        controlUnit: 'HOURS',
      });
      ordenTrabajoCreate.mockResolvedValue(MOCK_HISTORICA);
      userFindMany.mockResolvedValue([]);

      await service.createHistorica({ ...DTO, equipoId: 'CM-003' }, 'u_admin');

      const [{ data }] = ordenTrabajoCreate.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toMatchObject({ equipoId: 'CM-003' });
    });

    it('guarda quién la hizo y la lectura como nota, en km para un liviano', async () => {
      equipmentFindUnique.mockResolvedValueOnce({
        internalCode: 'TLRV40',
        controlUnit: 'KM',
      });
      ordenTrabajoCreate.mockResolvedValue(MOCK_HISTORICA);
      userFindMany.mockResolvedValue([]);

      await service.createHistorica(
        { ...DTO, realizadaPor: '  Taller externo Díaz  ', lectura: 84306 },
        'u_admin',
      );

      const [{ data }] = ordenTrabajoCreate.mock.calls[0] as [
        { data: { tareas: { create: Record<string, unknown>[] } } },
      ];
      expect(data.tareas.create[0]).toMatchObject({
        hechaPorNombre: 'Taller externo Díaz',
        notas: 'Kilometraje al momento de la mantención: 84.306 km',
      });
    });

    it('la lectura de un pesado queda como horómetro en horas', async () => {
      equipmentFindUnique.mockResolvedValueOnce({
        internalCode: 'CM-003',
        controlUnit: 'HOURS',
      });
      ordenTrabajoCreate.mockResolvedValue(MOCK_HISTORICA);
      userFindMany.mockResolvedValue([]);

      await service.createHistorica({ ...DTO, lectura: 1250.5 }, 'u_admin');

      const [{ data }] = ordenTrabajoCreate.mock.calls[0] as [
        { data: { tareas: { create: Record<string, unknown>[] } } },
      ];
      expect(data.tareas.create[0]).toMatchObject({
        notas: 'Horómetro al momento de la mantención: 1.250,5 h',
      });
    });

    it('rechaza una fecha futura', async () => {
      await expect(
        service.createHistorica({ ...DTO, fecha: '2999-01-01' }, 'u_admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ordenTrabajoCreate).not.toHaveBeenCalled();
    });

    it('404 si el equipo no existe ni por id ni por código', async () => {
      equipmentFindUnique.mockResolvedValue(null);

      await expect(
        service.createHistorica(DTO, 'u_admin'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(ordenTrabajoCreate).not.toHaveBeenCalled();
    });

    describe('con registros estructurados (ancla)', () => {
      const PESADO = {
        id: 'eq_flota_1',
        internalCode: 'CM-003',
        equipmentClass: 'HEAVY',
        controlUnit: 'HOURS',
        currentHourmeter: 1_300,
        currentMileage: null,
      };
      const LIVIANO = {
        id: 'eq_liv',
        internalCode: 'CM-010',
        equipmentClass: 'LIGHT',
        controlUnit: 'KM',
        currentHourmeter: null,
        currentMileage: 31_000,
      };
      const PLAN = {
        milestones: [250, 500],
        initialMilestone: 50,
        items: [
          {
            id: 'item_a',
            description: 'Cambio de aceite',
            kind: 'ACEITE',
            milestones: [250, 500],
          },
          {
            id: 'item_b',
            description: 'Cambio de correa',
            kind: 'CORREA',
            milestones: [500],
          },
        ],
      };

      beforeEach(() => {
        ordenTrabajoCreate.mockResolvedValue(MOCK_HISTORICA);
        userFindMany.mockResolvedValue([{ id: 'u_admin', name: 'Admin SMI' }]);
        planFindUnique.mockResolvedValue(PLAN);
      });

      it('historica with milestone writes one record per item at that milestone', async () => {
        equipmentFindUnique.mockResolvedValue(PESADO);

        await service.createHistorica(
          { ...DTO, milestone: 500, lectura: 1_250 },
          'u_admin',
        );

        // 1.250 h con ciclo de 500 h = vuelta 3.
        expect(recordUpsert).toHaveBeenCalledTimes(2);
        const doneAt = new Date('2025-06-15T12:00:00.000Z');
        expect(recordUpsert).toHaveBeenCalledWith({
          where: {
            planItemId_cycle_milestone: {
              planItemId: 'item_b',
              cycle: 3,
              milestone: 500,
            },
          },
          create: {
            equipmentId: 'eq_flota_1',
            planItemId: 'item_b',
            cycle: 3,
            milestone: 500,
            description: 'Cambio de correa',
            kind: 'CORREA',
            counterAt: 1_250,
            doneAt,
            doneById: 'u_admin',
            doneByName: 'Admin SMI',
          },
          update: { counterAt: 1_250, doneAt },
        });
        expect(ordenTrabajoCreate).toHaveBeenCalledTimes(1);
      });

      it('historica con el hito inicial escribe la vuelta 1 y prefiere realizadaPor', async () => {
        equipmentFindUnique.mockResolvedValue(PESADO);
        planFindUnique.mockResolvedValue({
          ...PLAN,
          items: [{ ...PLAN.items[0], milestones: [50, 250] }, PLAN.items[1]],
        });

        await service.createHistorica(
          { ...DTO, milestone: 50, lectura: 60, realizadaPor: ' Taller Díaz ' },
          'u_admin',
        );

        expect(recordUpsert).toHaveBeenCalledTimes(1);
        const [{ create }] = recordUpsert.mock.calls[0] as [
          { create: Record<string, unknown> },
        ];
        expect(create).toMatchObject({
          cycle: 1,
          milestone: 50,
          doneByName: 'Taller Díaz',
        });
      });

      it('historica on light without plan writes SERVICIO anchor', async () => {
        equipmentFindUnique.mockResolvedValue(LIVIANO);
        planFindUnique.mockResolvedValue(null);
        recordCount.mockResolvedValue(2);

        await service.createHistorica({ ...DTO, lectura: 30_000 }, 'u_admin');

        expect(recordCreate).toHaveBeenCalledWith({
          data: {
            equipmentId: 'eq_liv',
            planItemId: null,
            kind: 'SERVICIO',
            milestone: 10_000,
            cycle: 3,
            description: DTO.titulo,
            counterAt: 30_000,
            doneById: 'u_admin',
            doneByName: 'Admin SMI',
            doneAt: new Date('2025-06-15T12:00:00.000Z'),
          },
        });
        expect(recordUpsert).not.toHaveBeenCalled();
      });

      it('una CORRECTIVA con hito se rechaza: solo una preventiva cuenta para la pauta', async () => {
        equipmentFindUnique.mockResolvedValue(PESADO);

        await expect(
          service.createHistorica(
            { ...DTO, tipo: 'CORRECTIVA', milestone: 500, lectura: 1_250 },
            'u_admin',
          ),
        ).rejects.toThrow(
          new BadRequestException(
            'Solo una mantención preventiva cuenta para la pauta.',
          ),
        );
        expect(ordenTrabajoCreate).not.toHaveBeenCalled();
        expect(recordUpsert).not.toHaveBeenCalled();
      });

      it('una CORRECTIVA de un liviano sin pauta no escribe el servicio (ancla)', async () => {
        equipmentFindUnique.mockResolvedValue(LIVIANO);
        planFindUnique.mockResolvedValue(null);
        recordCount.mockResolvedValue(2);

        await service.createHistorica(
          { ...DTO, tipo: 'CORRECTIVA', lectura: 30_000 },
          'u_admin',
        );

        expect(ordenTrabajoCreate).toHaveBeenCalledTimes(1);
        expect(recordCreate).not.toHaveBeenCalled();
        expect(recordUpsert).not.toHaveBeenCalled();
      });

      it('historica milestone without lectura is rejected', async () => {
        equipmentFindUnique.mockResolvedValue(PESADO);

        await expect(
          service.createHistorica({ ...DTO, milestone: 500 }, 'u_admin'),
        ).rejects.toThrow(
          new BadRequestException(
            'Indica el horómetro/kilometraje de la mantención',
          ),
        );
        expect(ordenTrabajoCreate).not.toHaveBeenCalled();
        expect(recordUpsert).not.toHaveBeenCalled();
      });

      it('historica milestone not in plan is rejected', async () => {
        equipmentFindUnique.mockResolvedValue(PESADO);

        await expect(
          service.createHistorica(
            { ...DTO, milestone: 750, lectura: 700 },
            'u_admin',
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(ordenTrabajoCreate).not.toHaveBeenCalled();
        expect(recordUpsert).not.toHaveBeenCalled();
      });

      it('historica milestone without items is rejected', async () => {
        equipmentFindUnique.mockResolvedValue(PESADO);
        planFindUnique.mockResolvedValue({
          ...PLAN,
          milestones: [250, 500, 750],
        });

        await expect(
          service.createHistorica(
            { ...DTO, milestone: 750, lectura: 700 },
            'u_admin',
          ),
        ).rejects.toThrow(
          new BadRequestException(
            'Esa mantención no tiene operaciones en la pauta',
          ),
        );
        expect(ordenTrabajoCreate).not.toHaveBeenCalled();
      });

      it('historica lectura above current counter is rejected', async () => {
        equipmentFindUnique.mockResolvedValue(PESADO);

        await expect(
          service.createHistorica(
            { ...DTO, milestone: 500, lectura: 1_400 },
            'u_admin',
          ),
        ).rejects.toThrow(
          new BadRequestException(
            'La lectura de la mantención (1.400) no puede ser mayor que la lectura actual del equipo (1.300).',
          ),
        );
        expect(ordenTrabajoCreate).not.toHaveBeenCalled();
        expect(recordUpsert).not.toHaveBeenCalled();
      });

      it('sin milestone en un equipo con pauta no escribe registros (flujo de la ficha)', async () => {
        equipmentFindUnique.mockResolvedValue(PESADO);

        await service.createHistorica({ ...DTO, lectura: 1_000 }, 'u_admin');

        expect(recordUpsert).not.toHaveBeenCalled();
        expect(recordCreate).not.toHaveBeenCalled();
        expect(ordenTrabajoCreate).toHaveBeenCalledTimes(1);
      });
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
        service.update('orden_1', { estado: 'COMPLETADA' }, MOCK_MANTENEDOR, {
          estado: 'PENDIENTE',
        }),
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
        MOCK_MANTENEDOR,
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
        MOCK_MANTENEDOR,
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
        service.update('orden_1', { estado: 'COMPLETADA' }, MOCK_MANTENEDOR, {
          estado: 'PENDIENTE',
        }),
      ).rejects.toThrow('boom');
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('update — estado del equipo al completar ("Finalizar tarea")', () => {
    const enProceso = { ...MOCK_ORDEN, estado: 'EN_PROCESO' };

    beforeEach(() => {
      userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);
    });

    it('a COMPLETADA con equipmentStatus: deja el equipo en ese estado dentro de la transacción', async () => {
      ordenTrabajoFindUnique.mockResolvedValue(enProceso);
      ordenTrabajoUpdate.mockResolvedValue({
        ...enProceso,
        estado: 'COMPLETADA',
      });

      await service.update(
        'orden_1',
        {
          estado: 'COMPLETADA',
          equipmentStatus: 'OUT_OF_SERVICE',
        },
        MOCK_MANTENEDOR,
      );

      // `equipoId` de la OT ('CM-003') resuelto contra Flota, como en insumos.
      expect(equipmentUpdate).toHaveBeenCalledWith({
        where: { id: 'eq_flota_1' },
        data: { status: 'OUT_OF_SERVICE' },
      });
    });

    it('equipmentStatus sin pasar a COMPLETADA: 400 y no escribe nada', async () => {
      ordenTrabajoFindUnique.mockResolvedValue(enProceso);

      await expect(
        service.update(
          'orden_1',
          {
            titulo: 'Otro título',
            equipmentStatus: 'OPERATIONAL',
          },
          MOCK_MANTENEDOR,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(ordenTrabajoUpdate).not.toHaveBeenCalled();
      expect(equipmentUpdate).not.toHaveBeenCalled();
    });

    it('equipo no resoluble (texto libre): completa la orden sin tocar Flota', async () => {
      ordenTrabajoFindUnique.mockResolvedValue(enProceso);
      ordenTrabajoUpdate.mockResolvedValue({
        ...enProceso,
        estado: 'COMPLETADA',
      });
      equipmentFindUnique.mockResolvedValue(null);

      await service.update(
        'orden_1',
        {
          estado: 'COMPLETADA',
          equipmentStatus: 'OPERATIONAL',
        },
        MOCK_MANTENEDOR,
      );

      expect(ordenTrabajoUpdate).toHaveBeenCalled();
      expect(equipmentUpdate).not.toHaveBeenCalled();
    });

    it('con X-Expected el equipo también se actualiza (misma transacción del cierre)', async () => {
      queryRaw.mockResolvedValue([{ id: 'orden_1' }]);
      ordenTrabajoFindUnique
        .mockResolvedValueOnce(enProceso)
        .mockResolvedValueOnce({
          estado: 'EN_PROCESO',
          asignadoAId: 'user_mantenedor',
          prioridad: 'CRITICA',
          titulo: 'Frenos con baja respuesta',
        });
      ordenTrabajoUpdate.mockResolvedValue({
        ...enProceso,
        estado: 'COMPLETADA',
      });

      await service.update(
        'orden_1',
        { estado: 'COMPLETADA', equipmentStatus: 'OPERATIONAL' },
        MOCK_MANTENEDOR,
        { estado: 'EN_PROCESO' },
      );

      expect(equipmentUpdate).toHaveBeenCalledWith({
        where: { id: 'eq_flota_1' },
        data: { status: 'OPERATIONAL' },
      });
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

    it('un hallazgo de ZONA no inicia una orden de taller', async () => {
      hallazgoFindUnique.mockResolvedValue({ id: 'hallazgo_1', tipo: 'ZONA' });

      await expect(service.create(CREATE_DTO, 'user_1')).rejects.toThrow(
        'Un hallazgo de zona no se atiende en el taller.',
      );
      expect(hallazgoUpdateMany).not.toHaveBeenCalled();
      expect(ordenTrabajoCreate).not.toHaveBeenCalled();
    });

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

      await service.update(
        'orden_1',
        { estado: 'COMPLETADA' },
        MOCK_MANTENEDOR,
      );

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

      await service.update('orden_1', { estado: 'CANCELADA' }, MOCK_MANTENEDOR);

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

      await service.update(
        'orden_1',
        { titulo: 'Otro título' },
        MOCK_MANTENEDOR,
      );

      expect(hallazgoUpdate).not.toHaveBeenCalled();
      expect(hallazgoUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('lectura de la mantención al completar (ancla)', () => {
    /** La OT que crea `checkLightServices` para un liviano sin pauta. */
    const MOCK_LIVIANO = {
      ...MOCK_ORDEN,
      id: 'orden_liv',
      equipoId: 'eq_liv',
      titulo: 'Mantención 30.000 km · CM-010',
      estado: 'EN_PROCESO',
      tipo: 'PREVENTIVA',
      origen: 'PREVENTIVO',
      origenDetalle: 'Livianos: mantención de 30.000 km',
    };
    const CAMIONETA = {
      id: 'eq_liv',
      equipmentClass: 'LIGHT',
      controlUnit: 'KM',
      currentHourmeter: null,
      currentMileage: 31_500,
    };

    /** El último tick de la orden de pauta: la orden pasa sola a COMPLETADA. */
    const ultimoTick = (dto: { lecturaMantencion?: number }) => {
      tareaOTFindUnique.mockResolvedValue({
        id: 'tarea_b',
        ordenId: 'orden_prev',
        planItemId: 'item_b',
        texto: 'Cambio de filtro',
      });
      ordenTrabajoFindUnique.mockResolvedValue({
        ...MOCK_PREVENTIVA,
        estado: 'EN_PROCESO',
      });
      tareaOTUpdate.mockResolvedValue({
        id: 'tarea_b',
        texto: 'Cambio de filtro',
        hecha: true,
        posicion: 1,
        notas: null,
        fotoKey: null,
      });
      tareaOTFindMany.mockResolvedValue([{ hecha: true }, { hecha: true }]);
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_PREVENTIVA,
        estado: 'COMPLETADA',
      });
      return service.updateTarea(
        'orden_prev',
        'tarea_b',
        { hecha: true, ...dto },
        MOCK_MANTENEDOR,
      );
    };

    /** El argumento de la última llamada a un mock sin tipar: afirmarlo con
     * `expect.any()` dentro de un literal dispara `no-unsafe-assignment`. */
    const ultimaLlamada = (mockFn: jest.Mock) => {
      const calls = mockFn.mock.calls as unknown as Array<
        [{ where: Record<string, unknown>; data: Record<string, unknown> }]
      >;
      return calls[calls.length - 1][0];
    };

    beforeEach(() => {
      userFindMany.mockResolvedValue([MOCK_MANTENEDOR]);
    });

    it('last tick with lecturaMantencion rewrites counterAt of the milestone records', async () => {
      await ultimoTick({ lecturaMantencion: 240 });

      const { where, data } = ultimaLlamada(recordUpdateMany);
      expect(where).toEqual({
        equipmentId: { in: ['eq_flota_1', 'CM-003'] },
        planItemId: { not: null },
        cycle: 1,
        milestone: 250,
      });
      expect(data.counterAt).toBe(240);
      expect(data.doneAt).toBeInstanceOf(Date);
      expect(ordenTrabajoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: { estado: 'COMPLETADA' } }),
      );
    });

    it('completion without lecturaMantencion uses the current counter', async () => {
      await ultimoTick({});

      expect(ultimaLlamada(recordUpdateMany).data.counterAt).toBe(245);
    });

    it('lecturaMantencion above current counter is rejected and nothing is written', async () => {
      await expect(ultimoTick({ lecturaMantencion: 300 })).rejects.toThrow(
        new BadRequestException(
          'La lectura de la mantención (300) no puede ser mayor que la lectura actual del equipo (245).',
        ),
      );
      expect(tareaOTUpdate).not.toHaveBeenCalled();
      expect(recordUpsert).not.toHaveBeenCalled();
      expect(recordUpdateMany).not.toHaveBeenCalled();
      expect(ordenTrabajoUpdate).not.toHaveBeenCalled();
    });

    it('lecturaMantencion below previous anchor is rejected', async () => {
      equipmentFindUnique.mockResolvedValue({
        id: 'eq_flota_1',
        equipmentClass: 'HEAVY',
        controlUnit: 'HOURS',
        currentHourmeter: 1_300,
        currentMileage: null,
      });
      recordFindMany.mockResolvedValue([
        {
          equipmentId: 'eq_flota_1',
          milestone: 500,
          cycle: 0,
          counterAt: 1_200,
          doneAt: new Date('2026-10-01T12:00:00.000Z'),
        },
      ]);

      await expect(ultimoTick({ lecturaMantencion: 1_100 })).rejects.toThrow(
        new BadRequestException(
          'La lectura de la mantención (1.100) no puede ser menor que la de la mantención anterior (1.200).',
        ),
      );
      expect(tareaOTUpdate).not.toHaveBeenCalled();
      expect(recordUpdateMany).not.toHaveBeenCalled();
    });

    it('la mantención anterior no cuenta los registros de esta misma orden (marcados al tickear)', async () => {
      await ultimoTick({ lecturaMantencion: 240 });

      // Los registros de este hito y vuelta ya pueden ser el ancla: corregir
      // la lectura hacia abajo no puede chocar contra sí misma.
      const { where } = ultimaLlamada(recordFindMany);
      expect(where.planItemId).toEqual({ not: null });
      expect(where.NOT).toEqual({ cycle: 1, milestone: 250 });
    });

    it('completing a light service OT creates the SERVICIO anchor record', async () => {
      ordenTrabajoFindUnique.mockResolvedValue(MOCK_LIVIANO);
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_LIVIANO,
        estado: 'COMPLETADA',
      });
      equipmentFindUnique.mockResolvedValue(CAMIONETA);
      recordCount.mockResolvedValue(2);

      await service.update(
        'orden_liv',
        { estado: 'COMPLETADA', lecturaMantencion: 31_000 },
        MOCK_MANTENEDOR,
      );

      expect(recordCount).toHaveBeenCalledWith({
        where: { equipmentId: 'eq_liv', planItemId: null, kind: 'SERVICIO' },
      });
      expect(recordCreate).toHaveBeenCalledWith({
        data: {
          equipmentId: 'eq_liv',
          planItemId: null,
          kind: 'SERVICIO',
          milestone: 10_000,
          cycle: 3,
          description: 'Mantención 30.000 km · CM-010',
          counterAt: 31_000,
          doneById: MOCK_MANTENEDOR.id,
          doneByName: MOCK_MANTENEDOR.name,
        },
      });
    });

    it('un liviano con pauta no escribe el ancla de servicio', async () => {
      ordenTrabajoFindUnique.mockResolvedValue(MOCK_LIVIANO);
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_LIVIANO,
        estado: 'COMPLETADA',
      });
      equipmentFindUnique.mockResolvedValue(CAMIONETA);
      planFindUnique.mockResolvedValue({ id: 'plan_1' });

      await service.update(
        'orden_liv',
        { estado: 'COMPLETADA', lecturaMantencion: 31_000 },
        MOCK_MANTENEDOR,
      );

      expect(recordCreate).not.toHaveBeenCalled();
      expect(ordenTrabajoUpdate).toHaveBeenCalled();
    });

    it('lecturaMantencion on a non-completing update is rejected', async () => {
      ordenTrabajoFindUnique.mockResolvedValue(MOCK_LIVIANO);

      await expect(
        service.update(
          'orden_liv',
          { titulo: 'Otro título', lecturaMantencion: 31_000 },
          MOCK_MANTENEDOR,
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'La lectura de la mantención solo se informa al completar la orden',
        ),
      );
      expect(ordenTrabajoUpdate).not.toHaveBeenCalled();
      expect(recordCreate).not.toHaveBeenCalled();
    });

    it('el reintento de un cierre ya aplicado no vuelve a escribir el ancla', async () => {
      ordenTrabajoFindUnique.mockResolvedValue({
        ...MOCK_LIVIANO,
        estado: 'COMPLETADA',
      });
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_LIVIANO,
        estado: 'COMPLETADA',
      });
      equipmentFindUnique.mockResolvedValue(CAMIONETA);

      await service.update(
        'orden_liv',
        { estado: 'COMPLETADA', lecturaMantencion: 31_000 },
        MOCK_MANTENEDOR,
      );

      expect(recordCreate).not.toHaveBeenCalled();
    });

    it('a close whose in-transaction state is already COMPLETADA writes no SERVICIO record', async () => {
      // Fuera de la transacción se veía EN_PROCESO; bajo el bloqueo, otro
      // cierre (un reintento offline) ya la dejó COMPLETADA.
      ordenTrabajoFindUnique
        .mockResolvedValueOnce(MOCK_LIVIANO)
        .mockResolvedValueOnce({ ...MOCK_LIVIANO, estado: 'COMPLETADA' });
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_LIVIANO,
        estado: 'COMPLETADA',
      });
      equipmentFindUnique.mockResolvedValue(CAMIONETA);

      await service.update(
        'orden_liv',
        { estado: 'COMPLETADA', lecturaMantencion: 31_000 },
        MOCK_MANTENEDOR,
      );

      expect(queryRaw).toHaveBeenCalled();
      expect(recordCreate).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('un liviano sin kilometraje no gasta un número de servicio', async () => {
      ordenTrabajoFindUnique.mockResolvedValue(MOCK_LIVIANO);
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_LIVIANO,
        estado: 'COMPLETADA',
      });
      equipmentFindUnique.mockResolvedValue({
        ...CAMIONETA,
        currentMileage: null,
      });

      await service.update(
        'orden_liv',
        { estado: 'COMPLETADA' },
        MOCK_MANTENEDOR,
      );

      expect(recordCreate).not.toHaveBeenCalled();
      expect(ordenTrabajoUpdate).toHaveBeenCalled();
    });

    it('pauta OT closed via update with zero ticked tasks creates records for its plan tasks with the reading', async () => {
      ordenTrabajoFindUnique.mockResolvedValue({
        ...MOCK_PREVENTIVA,
        estado: 'EN_PROCESO',
      });
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_PREVENTIVA,
        estado: 'COMPLETADA',
      });
      planItemFindMany.mockResolvedValue([
        { id: 'item_a', description: 'Cambio de aceite', kind: 'LUBRICANTE' },
        { id: 'item_b', description: 'Cambio de filtro', kind: 'FILTRO' },
      ]);

      await service.update(
        'orden_prev',
        { estado: 'COMPLETADA', lecturaMantencion: 240 },
        MOCK_MANTENEDOR,
      );

      const registro = (
        planItemId: string,
        description: string,
        kind: string,
      ) => ({
        equipmentId: 'eq_flota_1',
        planItemId,
        cycle: 1,
        milestone: 250,
        description,
        kind,
        counterAt: 240,
        doneById: MOCK_MANTENEDOR.id,
        doneByName: MOCK_MANTENEDOR.name,
      });
      expect(planItemFindMany).toHaveBeenCalledWith({
        where: { id: { in: ['item_a', 'item_b'] } },
        select: { id: true, description: true, kind: true },
      });
      expect(recordCreateMany).toHaveBeenCalledWith({
        data: [
          registro('item_a', 'Cambio de aceite', 'LUBRICANTE'),
          registro('item_b', 'Cambio de filtro', 'FILTRO'),
        ],
        skipDuplicates: true,
      });
      expect(ultimaLlamada(recordUpdateMany).data.counterAt).toBe(240);
      // Las tareas quedan como estaban: solo el hito se da por hecho.
      expect(tareaOTUpdate).not.toHaveBeenCalled();
    });

    it('una orden corriente completada no escribe ancla', async () => {
      ordenTrabajoFindUnique.mockResolvedValue({
        ...MOCK_ORDEN,
        estado: 'EN_PROCESO',
      });
      ordenTrabajoUpdate.mockResolvedValue({
        ...MOCK_ORDEN,
        estado: 'COMPLETADA',
      });

      await service.update(
        'orden_1',
        { estado: 'COMPLETADA', lecturaMantencion: 100 },
        MOCK_MANTENEDOR,
      );

      expect(recordCreate).not.toHaveBeenCalled();
      expect(recordUpdateMany).not.toHaveBeenCalled();
    });
  });
});
