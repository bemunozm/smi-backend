import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../common/prisma/prisma.service';
import { ChangeLogService } from '../../change-log/change-log.service';
import { MaintenancePlansService } from './maintenance-plans.service';
import type { SaveMaintenancePlanDto } from './dto/save-maintenance-plan.dto';

describe('MaintenancePlansService', () => {
  let service: MaintenancePlansService;
  const prisma = {
    equipment: { findUnique: jest.fn(), findMany: jest.fn() },
    maintenancePlan: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    maintenancePlanItem: {
      deleteMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    maintenanceRecord: {
      findMany: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
    ordenTrabajo: { findFirst: jest.fn(), create: jest.fn() },
    $executeRaw: jest.fn(),
    inventoryItem: { count: jest.fn() },
    lightVehicleConfig: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const changeLog = { record: jest.fn(), findFor: jest.fn() };
  const eventEmitter = { emit: jest.fn() };
  const editor = { id: 'u1', name: 'Admin SMI' };

  const D6 = {
    id: 'e1',
    internalCode: 'BD-005',
    controlUnit: 'HOURS',
    currentHourmeter: 2100,
    currentMileage: null,
  };

  const pauta: SaveMaintenancePlanDto = {
    milestones: [500, 250, 2000, 1000],
    items: [
      {
        kind: 'FILTRO',
        description: 'Filtro aceite motor',
        quantity: 1,
        milestones: [250, 500, 1000, 2000],
      },
      {
        kind: 'ACEITE',
        description: 'Aceite motor 15W-40',
        quantity: 24,
        unit: 'LT',
        milestones: [250, 500, 1000, 2000],
      },
    ],
  };

  /** Lo que devuelve la base después de guardar: la pauta tal cual llegó. */
  const guardada = (dto: SaveMaintenancePlanDto) => ({
    id: 'p1',
    equipmentId: 'e1',
    milestones: [...dto.milestones].sort((a, b) => a - b),
    initialMilestone: dto.initialMilestone ?? null,
    updatedAt: new Date(),
    createdAt: new Date(),
    items: dto.items.map((i, position) => ({
      id: `i${position}`,
      planId: 'p1',
      position,
      kind: i.kind,
      description: i.description,
      quantity: i.quantity ?? null,
      unit: i.unit ?? null,
      partNumber: null,
      inventoryItemId: null,
      milestones: i.milestones,
    })),
  });

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        MaintenancePlansService,
        { provide: PrismaService, useValue: prisma },
        { provide: ChangeLogService, useValue: changeLog },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();
    service = mod.get(MaintenancePlansService);
    jest.clearAllMocks();
    // El `save` real lee el id de cada fila creada (para conservarla en el
    // barrido final): el mock devuelve uno derivado de la descripción.
    prisma.maintenancePlanItem.create.mockImplementation(
      ({ data }: { data: { description: string } }) =>
        Promise.resolve({ id: `creada:${data.description}` }),
    );
    prisma.equipment.findUnique.mockResolvedValue(D6);
    // Sin cambios registrados: sin ancla, la próxima sale de los hitos absolutos.
    prisma.maintenanceRecord.findMany.mockResolvedValue([]);
    prisma.maintenancePlan.findUnique.mockResolvedValue(null);
    prisma.maintenancePlan.upsert.mockResolvedValue({ id: 'p1' });
    prisma.maintenancePlan.findUniqueOrThrow.mockResolvedValue(guardada(pauta));
    prisma.$transaction.mockImplementation(
      (fn: (tx: typeof prisma) => unknown) => fn(prisma),
    );
  });

  it('guarda la pauta con los hitos ordenados y devuelve la próxima mantención', async () => {
    const res = await service.save('e1', pauta, editor);

    const [upsert] = prisma.maintenancePlan.upsert.mock.calls[0] as [
      { create: { milestones: number[] } },
    ];
    expect(upsert.create.milestones).toEqual([250, 500, 1000, 2000]);
    // BD-005 con 2.100 h: va en las 100 del ciclo de 2.000, toca la de 250.
    expect(res.status.next).toMatchObject({ milestone: 250, remaining: 150 });
    expect(res.status.next?.items).toHaveLength(2);
  });

  it('registra quién armó la pauta y qué tiene', async () => {
    await service.save('e1', pauta, editor);

    const llamada = changeLog.record.mock.calls[0] as unknown[];
    const cambios = llamada[4] as { label: string; after: string }[];
    expect(llamada.slice(1, 4)).toEqual(['maintenance_plan', 'e1', editor]);
    expect(cambios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Hitos',
          after: '250, 500, 1.000, 2.000',
        }),
        expect.objectContaining({
          label: 'Aceite motor 15W-40',
          after: '24 LT · hitos 250, 500, 1.000, 2.000',
        }),
      ]),
    );
  });

  it('no escribe nada si la pauta no cambió', async () => {
    prisma.maintenancePlan.findUnique.mockResolvedValue(guardada(pauta));

    await service.save('e1', pauta, editor);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(changeLog.record).not.toHaveBeenCalled();
  });

  it('rechaza una marca en un hito que no existe', async () => {
    await expect(
      service.save(
        'e1',
        {
          ...pauta,
          items: [{ ...pauta.items[0], milestones: [250, 750] }],
        },
        editor,
      ),
    ).rejects.toThrow(/750, que no es un hito/);
  });

  it('rechaza un servicio inicial que no va antes del primer hito', async () => {
    await expect(
      service.save('e1', { ...pauta, initialMilestone: 300 }, editor),
    ).rejects.toThrow(/tiene que ir antes del primer hito/);
  });

  it('rechaza una pauta sin hitos', async () => {
    await expect(
      service.save('e1', { milestones: [], items: [] }, editor),
    ).rejects.toThrow(/al menos un hito/);
  });

  it('rechaza un repuesto que no está en el inventario', async () => {
    prisma.inventoryItem.count.mockResolvedValue(0);

    await expect(
      service.save(
        'e1',
        { ...pauta, items: [{ ...pauta.items[0], inventoryItemId: 'x' }] },
        editor,
      ),
    ).rejects.toThrow(/ya no existe en el inventario/);
  });

  /** Los camiones se miden en km: la pauta usa su kilometraje. */
  it('usa el kilometraje en los equipos que se miden en km', async () => {
    prisma.equipment.findUnique.mockResolvedValue({
      ...D6,
      controlUnit: 'KM',
      currentHourmeter: null,
      currentMileage: 15500,
    });
    prisma.maintenancePlan.findUnique.mockResolvedValue(
      guardada({ milestones: [10000], items: [] }),
    );

    const res = await service.findForEquipment('e1');

    expect(res.equipment).toMatchObject({ unit: 'km', counter: 15500 });
    expect(res.status.next).toMatchObject({
      milestone: 10000,
      remaining: 4500,
    });
  });

  it('calcula la próxima mantención de todos los equipos con pauta en una consulta', async () => {
    prisma.maintenancePlan.findMany.mockResolvedValue([guardada(pauta)]);
    prisma.equipment.findMany.mockResolvedValue([D6]);

    const filas = await service.statusForAll();

    expect(prisma.equipment.findMany).toHaveBeenCalledTimes(1);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ equipmentId: 'e1', unit: 'h' });
    expect(filas[0].status.next?.milestone).toBe(250);
  });

  /** Un cambio registrado del equipo, como lo devuelve la consulta del ancla. */
  const cambio = (milestone: number, cycle: number, counterAt: number) => ({
    equipmentId: 'e1',
    milestone,
    cycle,
    counterAt,
    doneAt: new Date('2026-11-01T12:00:00Z'),
  });

  /**
   * La consulta del ancla pide solo registros con contador; la de la vuelta,
   * los de un ciclo. El mock responde a cada una por su filtro.
   */
  const conAncla = (...anclas: ReturnType<typeof cambio>[]) =>
    prisma.maintenanceRecord.findMany.mockImplementation(
      ({ where }: { where: { counterAt?: unknown } }) =>
        Promise.resolve(where.counterAt ? anclas : []),
    );

  it('statusForAll usa el último cambio registrado como ancla', async () => {
    const hitos = [250, 500, 750, 1000, 1250, 1500, 1750, 2000];
    prisma.maintenancePlan.findMany.mockResolvedValue([
      guardada({
        milestones: hitos,
        items: [{ kind: 'FILTRO', description: 'Filtro', milestones: hitos }],
      }),
    ]);
    prisma.equipment.findMany.mockResolvedValue([
      { ...D6, currentHourmeter: 2_600 },
    ]);
    conAncla(cambio(500, 2, 2_480), cambio(250, 2, 2_230));

    const [fila] = await service.statusForAll();

    // La de 500 se hizo a las 2.480 h: la de 750 toca a las 2.730, no a las 2.750.
    expect(fila.status.next).toMatchObject({
      milestone: 750,
      dueAt: 2_730,
      remaining: 130,
    });
    expect(fila.status.anchor).toMatchObject({
      milestone: 500,
      counterAt: 2_480,
    });
    expect(fila.status.estimated).toBe(false);
    // Una sola consulta para todos los equipos, del cambio más nuevo al más viejo.
    expect(prisma.maintenanceRecord.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.maintenanceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          equipmentId: { in: ['e1'] },
          planItemId: { not: null },
          counterAt: { not: null },
        },
        orderBy: [{ counterAt: 'desc' }, { doneAt: 'desc' }],
      }),
    );
  });

  /**
   * Guardar la pauta no puede recrear las filas: su id ata el registro de
   * mantenciones hechas. Las que ya existían se actualizan en su lugar.
   */
  it('las filas RECIÉN creadas sobreviven al barrido final (regresión: pauta nueva quedaba vacía)', async () => {
    // Pauta nueva: nada existente, las dos filas se CREAN. El barrido
    // (`deleteMany id notIn conservadas`) debe excluirlas — antes las
    // borraba recién creadas y la pauta se guardaba sin operaciones.
    prisma.maintenancePlan.findUnique.mockResolvedValue(null);
    prisma.maintenancePlanItem.create
      .mockResolvedValueOnce({ id: 'nuevo_0' })
      .mockResolvedValueOnce({ id: 'nuevo_1' });

    await service.save('e1', pauta, editor);

    const [del] = prisma.maintenancePlanItem.deleteMany.mock.calls[0] as [
      { where: { id: { notIn: string[] } } },
    ];
    expect(del.where.id.notIn).toEqual(
      expect.arrayContaining(['nuevo_0', 'nuevo_1']),
    );
  });

  it('actualiza las filas existentes por id y solo borra las que se quitaron', async () => {
    const actual = guardada(pauta);
    prisma.maintenancePlan.findUnique.mockResolvedValue(actual);

    await service.save(
      'e1',
      {
        ...pauta,
        items: [
          { ...pauta.items[0], id: 'i0', quantity: 2 },
          { kind: 'CORREA', description: 'Correa nueva', milestones: [2000] },
        ],
      },
      editor,
    );

    const [upd] = prisma.maintenancePlanItem.update.mock.calls[0] as [
      { where: { id: string } },
    ];
    expect(upd.where.id).toBe('i0');
    expect(prisma.maintenancePlanItem.create).toHaveBeenCalledTimes(1);
    const [del] = prisma.maintenancePlanItem.deleteMany.mock.calls[0] as [
      { where: { id: { notIn: string[] } } },
    ];
    // Se conservan la actualizada Y la recién creada: el barrido solo borra
    // lo que ya no está en la pauta (acá, 'i1', que no vino).
    expect(del.where.id.notIn).toEqual(['i0', 'creada:Correa nueva']);
  });

  describe('ciclo de mantenciones', () => {
    beforeEach(() => {
      prisma.maintenancePlan.findUnique.mockResolvedValue(guardada(pauta));
      prisma.maintenanceRecord.findMany.mockResolvedValue([]);
    });

    it('sin indicar ciclo muestra la vuelta en curso (2.100 h → ciclo 2)', async () => {
      const v = await service.getCycle('e1');

      expect(v).toMatchObject({
        currentCycle: 2,
        cycle: 2,
        cycleStart: 2000,
        cycleEnd: 4000,
      });
      expect(v.columns.map((c) => c.milestone)).toEqual([250, 500, 1000, 2000]);
    });

    it('no deja ver ni registrar un ciclo que todavía no llega', async () => {
      await expect(service.getCycle('e1', 3)).rejects.toThrow(
        /va en el ciclo 2/,
      );
      await expect(
        service.setRecord(
          'e1',
          { planItemId: 'i0', cycle: 3, milestone: 250, done: true },
          editor,
        ),
      ).rejects.toThrow(/va en el ciclo 2/);
    });

    it('registra la operación hecha con quién y el horómetro', async () => {
      await service.setRecord(
        'e1',
        { planItemId: 'i0', cycle: 2, milestone: 250, done: true },
        editor,
      );

      const [arg] = prisma.maintenanceRecord.upsert.mock.calls[0] as [
        { create: Record<string, unknown> },
      ];
      expect(arg.create).toMatchObject({
        equipmentId: 'e1',
        planItemId: 'i0',
        cycle: 2,
        milestone: 250,
        description: 'Filtro aceite motor',
        counterAt: 2100,
        doneById: 'u1',
        doneByName: 'Admin SMI',
      });
    });

    it('desmarcar borra el registro', async () => {
      await service.setRecord(
        'e1',
        { planItemId: 'i0', cycle: 2, milestone: 250, done: false },
        editor,
      );

      expect(prisma.maintenanceRecord.deleteMany).toHaveBeenCalledWith({
        where: { planItemId: 'i0', cycle: 2, milestone: 250 },
      });
    });

    /** Las mantenciones se registran en orden dentro de la vuelta. */
    it('no deja marcar la de 500 con la de 250 a medias', async () => {
      await expect(
        service.setRecord(
          'e1',
          { planItemId: 'i0', cycle: 2, milestone: 500, done: true },
          editor,
        ),
      ).rejects.toThrow(/Primero hay que completar la mantención de 250/);
      expect(prisma.maintenanceRecord.upsert).not.toHaveBeenCalled();
    });

    it('no deja desmarcar la de 250 si ya hay registros de 500', async () => {
      prisma.maintenanceRecord.findMany.mockResolvedValue([
        { planItemId: 'i0', milestone: 250 },
        { planItemId: 'i1', milestone: 250 },
        { planItemId: 'i0', milestone: 500 },
      ]);

      await expect(
        service.setRecord(
          'e1',
          { planItemId: 'i0', cycle: 2, milestone: 250, done: false },
          editor,
        ),
      ).rejects.toThrow(/ya hay mantenciones registradas después/);
      expect(prisma.maintenanceRecord.deleteMany).not.toHaveBeenCalled();
    });

    /** Un equipo que entró con 2.100 h ya hizo todo el ciclo 1 fuera del sistema. */
    it('da por hecho lo previo a la entrada y no deja marcarlo', async () => {
      prisma.maintenancePlan.findUnique.mockResolvedValue({
        ...guardada(pauta),
        baselineCounter: 2100,
      });

      const ciclo1 = await service.getCycle('e1', 1);
      expect(ciclo1.columns.every((c) => c.complete && c.preSystem)).toBe(true);

      await expect(
        service.setRecord(
          'e1',
          { planItemId: 'i0', cycle: 1, milestone: 250, done: true },
          editor,
        ),
      ).rejects.toThrow(/anterior a que el equipo entrara al sistema/);
    });

    it('al crear la pauta guarda el horómetro con que entra el equipo', async () => {
      prisma.maintenancePlan.findUnique.mockResolvedValue(null);

      await service.save('e1', pauta, editor);

      const [arg] = prisma.maintenancePlan.upsert.mock.calls[0] as [
        { create: { baselineCounter: number | null } },
      ];
      expect(arg.create.baselineCounter).toBe(2100);
    });

    it('getCycle con ancla toma la vuelta en curso del ancla y corre los vencimientos', async () => {
      // La de 1.000 del ciclo 1 se hizo a las 1.900 h: la vuelta empezó en las
      // 900 y la de 2.000 toca a las 2.900. Por horómetro absoluto (2.100 h)
      // diría ciclo 2.
      conAncla(cambio(1000, 1, 1_900));

      const v = await service.getCycle('e1');

      expect(v).toMatchObject({
        currentCycle: 1,
        cycle: 1,
        cycleStart: 900,
        cycleEnd: 2_900,
      });
      expect(v.columns.map((c) => c.dueAt)).toEqual([
        1_150, 1_400, 1_900, 2_900,
      ]);
      await expect(
        service.setRecord(
          'e1',
          { planItemId: 'i0', cycle: 2, milestone: 250, done: true },
          editor,
        ),
      ).rejects.toThrow(/va en el ciclo 1/);
    });

    it('rechaza marcar una operación en un hito donde no figura', async () => {
      await expect(
        service.setRecord(
          'e1',
          { planItemId: 'i0', cycle: 1, milestone: 750, done: true },
          editor,
        ),
      ).rejects.toThrow(/no se hace a las 750/);
    });
  });

  /**
   * El aviso al mantenedor: dentro del margen se crea una orden preventiva
   * con las operaciones del hito, que es la tarjeta de su tablero.
   */
  describe('aviso preventivo', () => {
    const conAviso = (alertBefore: number | null, baselineCounter = 1000) => ({
      ...guardada(pauta),
      alertBefore,
      baselineCounter,
    });

    beforeEach(() => {
      prisma.maintenanceRecord.count.mockResolvedValue(0);
      prisma.ordenTrabajo.findFirst.mockResolvedValue(null);
      prisma.ordenTrabajo.create.mockResolvedValue({ id: 'ot1' });
    });

    it('a 150 h de la de 250 con aviso de 200 h crea la orden con sus tareas', async () => {
      prisma.maintenancePlan.findUnique.mockResolvedValue(conAviso(200));

      expect(await service.checkAlert('e1')).toBe('ot1');

      const [arg] = prisma.ordenTrabajo.create.mock.calls[0] as [
        {
          data: {
            titulo: string;
            tipo: string;
            origen: string;
            origenDetalle: string;
            prioridad: string;
            tareas: { create: { texto: string }[] };
          };
        },
      ];
      expect(arg.data).toMatchObject({
        titulo: 'Mantención preventiva 250 h · BD-005',
        tipo: 'PREVENTIVA',
        origen: 'PREVENTIVO',
        origenDetalle: 'Pauta: 250 h · ciclo 2',
        prioridad: 'MEDIA',
      });
      expect(arg.data.tareas.create.map((t) => t.texto)).toEqual([
        'Filtro aceite motor · 1',
        'Aceite motor 15W-40 · 24 LT',
      ]);
    });

    it('al crear la orden emite preventive-service.due con el hito y lo que falta', async () => {
      prisma.maintenancePlan.findUnique.mockResolvedValue(conAviso(200));

      await service.checkAlert('e1');

      expect(eventEmitter.emit).toHaveBeenCalledWith('preventive-service.due', {
        equipmentId: 'e1',
        equipmentCode: 'BD-005',
        ordenId: 'ot1',
        milestone: 250,
        unit: 'h',
        remaining: 150,
      });
    });

    it('fuera del margen no avisa', async () => {
      prisma.maintenancePlan.findUnique.mockResolvedValue(conAviso(100));

      expect(await service.checkAlert('e1')).toBeNull();
      expect(prisma.ordenTrabajo.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('sin aviso configurado no hace nada', async () => {
      prisma.maintenancePlan.findUnique.mockResolvedValue(conAviso(null));

      expect(await service.checkAlert('e1')).toBeNull();
      expect(prisma.ordenTrabajo.create).not.toHaveBeenCalled();
    });

    it('no repite la orden de un hito y ciclo que ya avisó', async () => {
      prisma.maintenancePlan.findUnique.mockResolvedValue(conAviso(200));
      prisma.ordenTrabajo.findFirst.mockResolvedValue({ id: 'ot-vieja' });

      expect(await service.checkAlert('e1')).toBeNull();
      expect(prisma.ordenTrabajo.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('no crea una segunda orden si el equipo ya tiene una preventiva abierta de otro hito', async () => {
      prisma.maintenancePlan.findUnique.mockResolvedValue(conAviso(200));
      // Nada con este `origenDetalle`, pero sí una preventiva sin cerrar.
      prisma.ordenTrabajo.findFirst.mockImplementation(
        ({ where }: { where: { estado?: unknown } }) =>
          Promise.resolve(where.estado ? { id: 'ot-abierta' } : null),
      );

      expect(await service.checkAlert('e1')).toBeNull();
      expect(prisma.ordenTrabajo.create).not.toHaveBeenCalled();
      expect(prisma.ordenTrabajo.findFirst).toHaveBeenCalledWith({
        where: {
          equipoId: { in: ['e1', 'BD-005'] },
          origen: 'PREVENTIVO',
          estado: { in: ['PENDIENTE', 'ASIGNADA', 'EN_PROCESO'] },
        },
        select: { id: true },
      });
    });

    it('anclado y atrasado: crea la orden con prioridad ALTA y la vuelta del ancla', async () => {
      // Entró con 2.100 h, pero hay un cambio real: lo previo al sistema ya no
      // descarta nada. La de 1.000 del ciclo 1 se hizo a las 1.000 h: la de
      // 2.000 tocaba a las 2.000 y van 100 h de atraso.
      prisma.maintenancePlan.findUnique.mockResolvedValue(conAviso(200, 2100));
      conAncla(cambio(1000, 1, 1_000));

      expect(await service.checkAlert('e1')).toBe('ot1');

      const [arg] = prisma.ordenTrabajo.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(arg.data).toMatchObject({
        titulo: 'Mantención preventiva 2.000 h · BD-005',
        origenDetalle: 'Pauta: 2.000 h · ciclo 1',
        pautaMilestone: 2000,
        pautaCycle: 1,
        prioridad: 'ALTA',
      });
      expect(prisma.maintenanceRecord.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          cycle: 1,
          milestone: 2000,
        }) as unknown,
      });
    });

    it('no avisa si el mantenedor ya registró ese hito completo', async () => {
      prisma.maintenancePlan.findUnique.mockResolvedValue(conAviso(200));
      prisma.maintenanceRecord.count.mockResolvedValue(2);

      expect(await service.checkAlert('e1')).toBeNull();
    });

    it('la revisión general cuenta las órdenes que creó', async () => {
      prisma.maintenancePlan.findMany.mockResolvedValue([
        { equipmentId: 'e1' },
      ]);
      prisma.maintenancePlan.findUnique.mockResolvedValue(conAviso(200));

      expect(await service.checkAll()).toBe(1);
    });
  });
  describe('board', () => {
    it('devuelve una fila por equipo, con consultas fijas', async () => {
      const base = {
        brand: 'CAT',
        model: 'X',
        status: 'OPERATIONAL',
        currentHourmeter: null,
        currentMileage: null,
      };
      prisma.equipment.findMany.mockResolvedValue([
        {
          ...base,
          id: 'e1',
          internalCode: 'BD-005',
          type: 'Bulldozer',
          equipmentClass: 'HEAVY',
          controlUnit: 'HOURS',
          currentHourmeter: 2100,
        },
        {
          ...base,
          id: 'e2',
          internalCode: 'LV-001',
          type: 'Camioneta',
          equipmentClass: 'LIGHT',
          controlUnit: 'KM',
          currentMileage: 24000,
          status: 'OUT_OF_SERVICE',
        },
        {
          ...base,
          id: 'e3',
          internalCode: 'GR-001',
          type: 'Grua',
          equipmentClass: 'HEAVY',
          controlUnit: 'HOURS',
        },
      ]);
      prisma.maintenancePlan.findMany.mockResolvedValue([
        { ...guardada(pauta), equipmentId: 'e1', alertBefore: 20 },
      ]);
      prisma.lightVehicleConfig.findMany.mockResolvedValue([
        { equipmentId: 'e2', serviceAlertKm: 1500 },
      ]);
      prisma.maintenanceRecord.findMany.mockResolvedValue([]);

      const filas = await service.board();

      expect(filas.map((f) => [f.equipmentId, f.source])).toEqual([
        ['e1', 'PAUTA'],
        ['e2', 'LIVIANO'],
        ['e3', 'SIN_PAUTA'],
      ]);
      expect(filas[1].alertBefore).toBe(1500);
      expect(prisma.equipment.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.maintenancePlan.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.lightVehicleConfig.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.maintenanceRecord.findMany).toHaveBeenCalledTimes(2);
    });
  });
});
