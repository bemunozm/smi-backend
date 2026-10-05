import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TrabajosExtraService } from './trabajos-extra.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ChangeLogService } from '../../change-log/change-log.service';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import { OperatorsService } from '../../operators/operators.service';
import { CreateTrabajoExtraDto } from './dto/create-trabajo-extra.dto';
import { UpdateTrabajoExtraDto } from './dto/update-trabajo-extra.dto';

describe('TrabajosExtraService', () => {
  let service: TrabajosExtraService;
  const USER_ID = 'u1';
  const createAs = (dto: CreateTrabajoExtraDto) => service.create(dto, USER_ID);
  const prisma = {
    equipment: { findUnique: jest.fn() },
    trabajoExtraordinario: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    // Se mockea para probar que un turno abierto no bloquea el trabajo.
    registroHorometro: { findFirst: jest.fn() },
    // La edición y su registro de cambios van en una sola transacción.
    $transaction: jest.fn(),
    // Bloqueo de la fila (`FOR UPDATE`) cuando la edición trae `X-Expected`.
    $queryRaw: jest.fn().mockResolvedValue([{ id: 't1' }]),
  };
  const assertActive = jest.fn();
  const eventEmitter = { emit: jest.fn() };
  const changeLog = { record: jest.fn(), findFor: jest.fn() };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        TrabajosExtraService,
        { provide: PrismaService, useValue: prisma },
        { provide: OperatorsService, useValue: { assertActive } },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ChangeLogService, useValue: changeLog },
      ],
    }).compile();
    service = mod.get(TrabajosExtraService);
    jest.clearAllMocks();
    prisma.equipment.findUnique.mockResolvedValue({
      id: 'e1',
      internalCode: 'CA-011',
    });
    prisma.registroHorometro.findFirst.mockResolvedValue(null);
    prisma.trabajoExtraordinario.findUnique.mockResolvedValue(null);
    prisma.trabajoExtraordinario.findFirst.mockResolvedValue(null);
    prisma.trabajoExtraordinario.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => data,
    );
    // Operador del catálogo por defecto — activo. Los tests de
    // operatorId/OPERATOR_INACTIVE sobreescriben esto.
    assertActive.mockResolvedValue({
      id: 'op_1',
      name: 'Juan Rojas',
      isActive: true,
    });
  });

  it('calcula totalHoras = horometroFinal - horometroInicial', async () => {
    const res = await createAs({
      equipoId: 'e1',
      operatorId: 'op_1',
      faena: 'Rajo Norte',
      turno: 'DIURNO',
      horometroInicial: 1200,
      horometroFinal: 1212,
      actividades: ['REGULACION_CARGA'],
      descripcion: 'Carga de material',
    });
    expect(res.totalHoras).toBe(12);
  });

  /**
   * El caso que antes pasaba en silencio: guardaba `totalHoras: 0` y devolvía
   * 201, dejando en la base un trabajo de cero horas indistinguible de uno
   * legítimo. Estas horas respaldan un cobro, así que el registro tiene que
   * fallar, no inventar un cero.
   */
  it('rechaza el horómetro final menor que el inicial en vez de guardar cero', async () => {
    const invertido: CreateTrabajoExtraDto = {
      equipoId: 'e1',
      operatorId: 'op_1',
      faena: 'Patillo',
      turno: 'NOCTURNO',
      horometroInicial: 5400,
      horometroFinal: 5388,
      actividades: ['HACER_PETRIL'],
      descripcion: 'Horómetro tipeado al revés',
    };

    await expect(createAs(invertido)).rejects.toThrow(/no puede ser menor/);
    expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
  });

  /** Un trabajo que de verdad duró cero sí se guarda: el rechazo es por menor, no por igual. */
  it('acepta inicial y final iguales', async () => {
    const res = await createAs({
      equipoId: 'e1',
      operatorId: 'op_1',
      faena: 'Kainita',
      turno: 'DIURNO',
      horometroInicial: 900,
      horometroFinal: 900,
      actividades: ['LIMPIEZA_CANCHA'],
      descripcion: 'Se canceló antes de empezar',
    });
    expect(res.totalHoras).toBe(0);
  });

  describe('actividades', () => {
    const trabajo = {
      equipoId: 'e1',
      operatorId: 'op_1',
      faena: 'Patillo',
      turno: 'DIURNO' as const,
      horometroInicial: 1200,
      horometroFinal: 1212,
      descripcion: 'Carga de material',
    };

    it('guarda varias actividades en un mismo trabajo', async () => {
      const res = await createAs({
        ...trabajo,
        actividades: ['SOLTAR_MATERIAL', 'LIMPIEZA_CANCHA'],
      });
      expect(res.actividades).toEqual(['SOLTAR_MATERIAL', 'LIMPIEZA_CANCHA']);
      expect(res.otraActividad).toBeNull();
    });

    /**
     * «Otro» sin texto deja la actividad registrada como «otro» a secas: el
     * trabajo no se podría justificar ni cobrar.
     */
    it('exige el texto cuando se elige Otro', async () => {
      await expect(
        createAs({ ...trabajo, actividades: ['OTRO'] }),
      ).rejects.toThrow(/describí cuál fue/);
      expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
    });

    it('guarda el texto de Otro junto a las demás actividades', async () => {
      const res = await createAs({
        ...trabajo,
        actividades: ['HACER_PETRIL', 'OTRO'],
        otraActividad: '  Despeje de acceso a romana  ',
      });
      expect(res.otraActividad).toBe('Despeje de acceso a romana');
    });

    /** Un texto sin haber elegido «Otro» contradiría la lista: se descarta. */
    it('descarta el texto si no se eligió Otro', async () => {
      const res = await createAs({
        ...trabajo,
        actividades: ['HACER_PETRIL'],
        otraActividad: 'texto huérfano',
      });
      expect(res.otraActividad).toBeNull();
    });
  });
  /**
   * El trabajo extraordinario usa la misma máquina del turno durante sus
   * tiempos en ralentí: un equipo con turno abierto tiene que poder registrar
   * su trabajo.
   */
  it('acepta el trabajo aunque el equipo tenga un turno en curso', async () => {
    prisma.registroHorometro.findFirst.mockResolvedValue({ id: 'h1' });

    const res = await createAs({
      equipoId: 'e1',
      operatorId: 'op_1',
      faena: 'Patillo',
      turno: 'DIURNO',
      horometroInicial: 1200,
      horometroFinal: 1212,
      actividades: ['REGULACION_CARGA'],
      descripcion: 'Carga de material',
    });

    expect(prisma.trabajoExtraordinario.create).toHaveBeenCalled();
    expect(res.equipoId).toBe('e1');
  });

  it('lanza NotFoundException si el equipo no existe', async () => {
    prisma.equipment.findUnique.mockResolvedValue(null);

    await expect(
      createAs({
        equipoId: 'missing',
        operatorId: 'op_1',
        faena: 'Patillo',
        turno: 'DIURNO',
        horometroInicial: 1200,
        horometroFinal: 1212,
        actividades: ['REGULACION_CARGA'],
        descripcion: 'Carga de material',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // El equipo se chequea ANTES que el operador (precondición más barata
    // primero): con equipo inexistente, ni siquiera se llega a validar el
    // operador.
    expect(assertActive).not.toHaveBeenCalled();
    expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
  });

  // `operador` sale del DTO — el cliente manda solo `operatorId`, y el
  // servidor arma el snapshot desde el catálogo.
  describe('operatorId (catálogo)', () => {
    it('valida el operador vía OperatorsService.assertActive y arma el snapshot desde el catálogo', async () => {
      assertActive.mockResolvedValue({
        id: 'op_9',
        name: 'Patricio Rojas',
        isActive: true,
      });

      const res = await createAs({
        equipoId: 'e1',
        operatorId: 'op_9',
        faena: 'Rajo Norte',
        turno: 'DIURNO',
        horometroInicial: 1200,
        horometroFinal: 1212,
        actividades: ['REGULACION_CARGA'],
        descripcion: 'Carga de material',
      });

      expect(assertActive).toHaveBeenCalledWith('op_9');
      // El snapshot viene SIEMPRE del catálogo (`operator.name`), nunca de
      // texto que hubiera mandado el cliente — el DTO ni siquiera tiene un
      // campo `operador` que pudiera contradecirlo.
      expect(res.operador).toBe('Patricio Rojas');
      expect(res.operatorId).toBe('op_9');
    });

    it('propaga el 404 si el operador no existe, sin llegar a las reglas de turno/horómetro', async () => {
      assertActive.mockRejectedValue(
        new NotFoundException('Operador "op_missing" no encontrado'),
      );

      await expect(
        createAs({
          equipoId: 'e1',
          operatorId: 'op_missing',
          faena: 'Rajo Norte',
          turno: 'DIURNO',
          horometroInicial: 1200,
          horometroFinal: 1212,
          actividades: ['REGULACION_CARGA'],
          descripcion: 'Carga de material',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Falla rápido: ni siquiera se llega a consultar si el equipo tiene
      // turno en curso.
      expect(prisma.registroHorometro.findFirst).not.toHaveBeenCalled();
      expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
    });

    it('propaga el 409 OPERATOR_INACTIVE si el operador existe pero está dado de baja', async () => {
      assertActive.mockRejectedValue(
        new ConflictException({
          message: 'El operador "Juan Rojas" está inactivo',
          code: 'OPERATOR_INACTIVE',
        }),
      );

      expect.assertions(3);
      try {
        await createAs({
          equipoId: 'e1',
          operatorId: 'op_1',
          faena: 'Rajo Norte',
          turno: 'DIURNO',
          horometroInicial: 1200,
          horometroFinal: 1212,
          actividades: ['REGULACION_CARGA'],
          descripcion: 'Carga de material',
        });
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'OPERATOR_INACTIVE',
        });
        expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
      }
    });
  });

  describe('idempotencia (reenvío offline)', () => {
    const ID = 'b3b6a1f2-6c5e-4d0e-9a55-0f4f0a7d2c11';
    const payload: CreateTrabajoExtraDto = {
      id: ID,
      equipoId: 'e1',
      operatorId: 'op_1',
      faena: 'Rajo Norte',
      turno: 'DIURNO',
      horometroInicial: 1200,
      horometroFinal: 1212,
      actividades: ['REGULACION_CARGA'],
      descripcion: 'Carga de material',
    };

    function createdData(): Record<string, unknown> {
      const [args] = prisma.trabajoExtraordinario.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      return args.data;
    }

    function p2002(): Prisma.PrismaClientKnownRequestError {
      return new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['id'] },
      });
    }

    it('crea con el id del cliente, el dueño y la hora de captura como fecha', async () => {
      const capturedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();

      await createAs({ ...payload, capturedAt });

      const data = createdData();
      expect(data.id).toBe(ID);
      expect(data.createdById).toBe(USER_ID);
      expect(data.fecha).toEqual(new Date(capturedAt));
    });

    it('sin id ni capturedAt usa la hora del servidor y no consulta por id', async () => {
      const before = Date.now();
      const sinId = { ...payload, id: undefined };

      await createAs(sinId);

      const data = createdData();
      expect('id' in data).toBe(false);
      expect((data.fecha as Date).getTime()).toBeGreaterThanOrEqual(before);
      expect(prisma.trabajoExtraordinario.findUnique).not.toHaveBeenCalled();
    });

    it('un capturedAt fuera de ventana no rechaza: se guarda con la hora del servidor', async () => {
      const antes = Date.now();

      await createAs({ ...payload, capturedAt: '2001-01-01T00:00:00.000Z' });

      const [args] = prisma.trabajoExtraordinario.create.mock.calls[0] as [
        { data: { fecha: Date } },
      ];
      expect(args.data.fecha.getTime()).toBeGreaterThanOrEqual(antes);
    });

    it('un capturedAt con formato inválido es 400 y no escribe', async () => {
      await expect(
        createAs({ ...payload, capturedAt: '2026-W01' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
    });

    it('guarda las observaciones vacías como null, no como texto vacío', async () => {
      await createAs({ ...payload, observaciones: '   ' });

      const [args] = prisma.trabajoExtraordinario.create.mock.calls[0] as [
        { data: { observaciones: string | null } },
      ];
      expect(args.data.observaciones).toBeNull();
    });

    it('el reintento del mismo usuario devuelve la fila existente sin re-evaluar reglas, aunque el operador se haya desactivado', async () => {
      const existing = { id: ID, operador: 'Juan Rojas' };
      prisma.trabajoExtraordinario.findUnique
        .mockResolvedValueOnce({ createdById: USER_ID })
        .mockResolvedValueOnce(existing);
      assertActive.mockRejectedValue(
        new ConflictException({
          message: 'inactivo',
          code: 'OPERATOR_INACTIVE',
        }),
      );
      prisma.registroHorometro.findFirst.mockResolvedValue({ id: 'h1' });

      const res = await createAs(payload);

      expect(res).toEqual({ id: ID, operador: 'Juan Rojas' });
      expect(prisma.equipment.findUnique).not.toHaveBeenCalled();
      expect(assertActive).not.toHaveBeenCalled();
      expect(prisma.registroHorometro.findFirst).not.toHaveBeenCalled();
      expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
    });

    it('el reintento de una fila ya creada no revalida capturedAt', async () => {
      const existing = { id: ID };
      prisma.trabajoExtraordinario.findUnique
        .mockResolvedValueOnce({ createdById: USER_ID })
        .mockResolvedValueOnce(existing);

      const res = await createAs({
        ...payload,
        capturedAt: '2001-01-01T00:00:00.000Z',
      });

      expect(res).toEqual({ id: ID });
    });

    it('otro usuario con el mismo id -> 409 ID_CONFLICT', async () => {
      prisma.trabajoExtraordinario.findUnique.mockResolvedValue({
        createdById: 'otro',
      });

      await expect(createAs(payload)).rejects.toMatchObject({
        status: 409,
        response: { code: 'ID_CONFLICT' },
      });
      expect(prisma.trabajoExtraordinario.create).not.toHaveBeenCalled();
    });

    it('una fila legacy sin dueño con ese id -> 409 ID_CONFLICT', async () => {
      prisma.trabajoExtraordinario.findUnique.mockResolvedValue({
        createdById: null,
      });

      await expect(createAs(payload)).rejects.toMatchObject({
        response: { code: 'ID_CONFLICT' },
      });
    });

    it('carrera P2002: relee y devuelve la fila propia', async () => {
      const winner = { id: ID };
      prisma.trabajoExtraordinario.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ createdById: USER_ID })
        .mockResolvedValueOnce(winner);
      prisma.trabajoExtraordinario.create.mockRejectedValueOnce(p2002());

      await expect(createAs(payload)).resolves.toEqual({ id: ID });
    });

    it('carrera P2002 contra otro usuario -> 409 ID_CONFLICT', async () => {
      prisma.trabajoExtraordinario.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ createdById: 'otro' });
      prisma.trabajoExtraordinario.create.mockRejectedValueOnce(p2002());

      await expect(createAs(payload)).rejects.toMatchObject({
        response: { code: 'ID_CONFLICT' },
      });
    });
  });
  /**
   * Un trabajo ya registrado se edita sin autorización,
   * pero cada cambio queda registrado (quién, qué dato, antes y después) y
   * se le avisa al administrador.
   */
  describe('update', () => {
    const editor = { id: 'u1', name: 'Supervisor de Prueba' };
    const guardado = {
      id: 't1',
      equipoId: 'e1',
      operatorId: 'op_1',
      equipo: { internalCode: 'CA-011' },
      operador: 'Juan Rojas',
      faena: 'Patillo',
      turno: 'DIURNO',
      horometroInicial: 1200,
      horometroFinal: 1212,
      totalHoras: 12,
      actividades: ['REGULACION_CARGA'],
      otraActividad: null,
      descripcion: 'Carga de material',
      observaciones: null,
      fecha: new Date(2026, 9, 1, 10, 0),
    };

    beforeEach(() => {
      prisma.trabajoExtraordinario.findUnique.mockResolvedValue(guardado);
      prisma.trabajoExtraordinario.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => ({
          ...guardado,
          ...data,
        }),
      );
      prisma.$transaction.mockImplementation(
        (fn: (tx: typeof prisma) => unknown) => fn(prisma),
      );
    });

    it('guarda el cambio, recalcula las horas y lo registra con su antes y después', async () => {
      const res = await service.update(
        't1',
        { horometroFinal: 1214.5 },
        editor,
      );

      expect(res.totalHoras).toBe(14.5);
      expect(changeLog.record).toHaveBeenCalledWith(
        prisma,
        'trabajo_extra',
        't1',
        editor,
        [
          {
            field: 'horometroFinal',
            label: 'Horómetro final',
            before: '1.212 h',
            after: '1.214,5 h',
          },
        ],
      );
    });

    it('avisa al administrador quién cambió qué', async () => {
      assertActive.mockResolvedValue({ id: 'op_2', name: 'Pedro Soto' });

      await service.update('t1', { operatorId: 'op_2' }, editor);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        DOMAIN_EVENTS.RECORD_EDITED,
        expect.objectContaining({
          entity: 'trabajo_extra',
          entityId: 't1',
          editedBy: 'Supervisor de Prueba',
          changes: [
            { label: 'Operador', before: 'Juan Rojas', after: 'Pedro Soto' },
          ],
        }),
      );
    });

    /** El snapshot `operador` lo deriva el servidor del catálogo, nunca el cliente. */
    it('cambia de operador por catálogo y deriva el nombre en el servidor', async () => {
      assertActive.mockResolvedValue({ id: 'op_2', name: 'Pedro Soto' });

      await service.update('t1', { operatorId: 'op_2' }, editor);

      expect(assertActive).toHaveBeenCalledWith('op_2');
      const [args] = prisma.trabajoExtraordinario.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data).toMatchObject({
        operatorId: 'op_2',
        operador: 'Pedro Soto',
      });
    });

    it('rechaza un operador inactivo sin escribir nada', async () => {
      assertActive.mockRejectedValue(new ConflictException('inactivo'));

      await expect(
        service.update('t1', { operatorId: 'op_x' }, editor),
      ).rejects.toThrow(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    /**
     * Editar otro dato no re-valida al operador ya guardado: si se desactivó
     * después, el registro sigue siendo corregible.
     */
    it('no re-valida al operador cuando el body no lo toca', async () => {
      await service.update('t1', { horometroFinal: 1214.5 }, editor);

      expect(assertActive).not.toHaveBeenCalled();
    });

    /** `operador` (texto libre) no es un campo editable: ver `UpdateTrabajoExtraDto`. */
    it('el DTO de edición rechaza `operador` de texto libre', async () => {
      const dto = plainToInstance(UpdateTrabajoExtraDto, { operador: 'X' });
      const errores = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errores).not.toHaveLength(0);
    });

    /** El aviso dice el código del equipo, no su id interno. */
    it('registra el cambio de equipo con sus códigos', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: 'e2',
        internalCode: 'CM-003',
      });

      await service.update('t1', { equipoId: 'e2' }, editor);

      const llamada = changeLog.record.mock.calls[0] as unknown[];
      const cambios = llamada[4] as { before: string; after: string }[];
      expect(cambios).toEqual([
        expect.objectContaining({
          label: 'Equipo',
          before: 'CA-011',
          after: 'CM-003',
        }),
      ]);
    });

    /** Las reglas se aplican al registro combinado, no solo a lo que vino. */
    it('rechaza un final menor que el inicial ya guardado', async () => {
      await expect(
        service.update('t1', { horometroFinal: 1100 }, editor),
      ).rejects.toThrow(/no puede ser menor/);
      expect(prisma.trabajoExtraordinario.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    /** La regla se evalúa sobre la fila vigente, no sobre una lectura previa. */
    it('valida el horómetro contra el inicial vigente bajo el bloqueo', async () => {
      prisma.trabajoExtraordinario.findUnique.mockResolvedValue({
        ...guardado,
        horometroInicial: 1213,
        horometroFinal: 1220,
      });

      await expect(
        service.update('t1', { horometroFinal: 1212 }, editor),
      ).rejects.toThrow(/no puede ser menor/);
      expect(prisma.trabajoExtraordinario.update).not.toHaveBeenCalled();
    });

    /** Guardar sin cambiar nada no es un cambio: no se registra ni se avisa. */
    it('no escribe, no registra ni avisa si nada cambió', async () => {
      await service.update('t1', { faena: 'Patillo' }, editor);

      expect(prisma.trabajoExtraordinario.update).not.toHaveBeenCalled();
      expect(changeLog.record).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('un cambio ajeno de OTRO campo confirmado antes del bloqueo no se revierte ni se registra como propio', async () => {
      // La fila vigente (leída bajo el bloqueo) ya trae la descripción que
      // otra persona corrigió después de que ésta empezó a editar.
      prisma.trabajoExtraordinario.findUnique.mockResolvedValue({
        ...guardado,
        descripcion: 'Carga de material y despeje',
      });

      await service.update('t1', { faena: 'Kainita' }, editor, {
        faena: 'Patillo',
      });

      const [args] = prisma.trabajoExtraordinario.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data.descripcion).toBe('Carga de material y despeje');
      expect(args.data.faena).toBe('Kainita');
      expect(changeLog.record).toHaveBeenCalledWith(
        prisma,
        'trabajo_extra',
        't1',
        editor,
        [
          {
            field: 'faena',
            label: 'Faena',
            before: 'Patillo',
            after: 'Kainita',
          },
        ],
      );
    });

    it('lo mismo sin X-Expected: el valor nuevo parte siempre de la fila vigente', async () => {
      prisma.trabajoExtraordinario.findUnique.mockResolvedValue({
        ...guardado,
        turno: 'NOCTURNO',
      });

      await service.update('t1', { faena: 'Kainita' }, editor);

      const [args] = prisma.trabajoExtraordinario.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data.turno).toBe('NOCTURNO');
    });

    it('guarda las observaciones vacías como null', async () => {
      prisma.trabajoExtraordinario.findUnique.mockResolvedValue({
        ...guardado,
        observaciones: 'algo',
      });

      await service.update('t1', { observaciones: '' }, editor);

      const [args] = prisma.trabajoExtraordinario.update.mock.calls[0] as [
        { data: { observaciones: string | null } },
      ];
      expect(args.data.observaciones).toBeNull();
    });

    /** El PATCH devuelve la misma forma que el listado: con `equipo`. El `createdById` lo omite el cliente de Prisma. */
    it('las queries de la edición piden equipo', async () => {
      await service.update('t1', { faena: 'Kainita' }, editor);

      const lecturaBloqueada = prisma.trabajoExtraordinario.findUnique.mock
        .calls[1] as [{ include: unknown }];
      const escritura = prisma.trabajoExtraordinario.update.mock.calls[0] as [
        { include: unknown },
      ];
      for (const [args] of [lecturaBloqueada, escritura]) {
        expect(args.include).toEqual({
          equipo: { select: { internalCode: true } },
        });
      }
    });

    describe('X-Expected', () => {
      it('bloquea la fila siempre, también sin precondición', async () => {
        await service.update('t1', { faena: 'Kainita' }, editor);

        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      });

      it('con la base vigente aplica el cambio bajo bloqueo', async () => {
        const res = await service.update(
          't1',
          { horometroFinal: 1214.5 },
          editor,
          { horometroFinal: 1212, actividades: ['REGULACION_CARGA'] },
        );

        expect(res.totalHoras).toBe(14.5);
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
        expect(changeLog.record).toHaveBeenCalledTimes(1);
      });

      it('si el dato ya vale lo deseado el reintento pasa sin escribir ni avisar', async () => {
        prisma.trabajoExtraordinario.findUnique.mockResolvedValue({
          ...guardado,
          horometroFinal: 1214.5,
          totalHoras: 14.5,
        });

        await service.update('t1', { horometroFinal: 1214.5 }, editor, {
          horometroFinal: 1212,
        });

        expect(prisma.trabajoExtraordinario.update).not.toHaveBeenCalled();
        expect(changeLog.record).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('si alguien más lo cambió responde 409 STALE_UPDATE sin escribir', async () => {
        const result = service.update(
          't1',
          { horometroFinal: 1214.5 },
          editor,
          {
            horometroFinal: 1100,
          },
        );

        await expect(result).rejects.toBeInstanceOf(ConflictException);
        await expect(result).rejects.toMatchObject({
          response: {
            code: 'STALE_UPDATE',
            message: expect.stringContaining('Horómetro final') as string,
          },
        });
        expect(prisma.trabajoExtraordinario.update).not.toHaveBeenCalled();
      });

      it('compara las actividades por contenido, no por referencia', async () => {
        await expect(
          service.update('t1', { faena: 'Kainita' }, editor, {
            actividades: ['REGULACION_CARGA'],
          }),
        ).resolves.toBeDefined();
      });

      it('un cambio ajeno confirmado antes del bloqueo da 409', async () => {
        prisma.trabajoExtraordinario.findUnique.mockResolvedValue({
          ...guardado,
          faena: 'Otra',
        });

        await expect(
          service.update('t1', { faena: 'Kainita' }, editor, {
            faena: 'Patillo',
          }),
        ).rejects.toMatchObject({ response: { code: 'STALE_UPDATE' } });
        expect(prisma.trabajoExtraordinario.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('forma de la respuesta (equipo incluido)', () => {
    const ID = 'b3b6a1f2-6c5e-4d0e-9a55-0f4f0a7d2c11';
    const INCLUDE = { equipo: { select: { internalCode: true } } };
    const payload: CreateTrabajoExtraDto = {
      id: ID,
      equipoId: 'e1',
      operatorId: 'op_1',
      faena: 'Rajo Norte',
      turno: 'DIURNO',
      horometroInicial: 1200,
      horometroFinal: 1212,
      actividades: ['REGULACION_CARGA'],
      descripcion: 'Carga de material',
    };
    const row = {
      id: ID,
      equipoId: 'e1',
      operador: 'Juan Rojas',
      equipo: { internalCode: 'CA-011' },
    };

    function expectQueryShape(fn: jest.Mock, call = 0): void {
      const [args] = fn.mock.calls[call] as [
        { include: unknown; omit: unknown },
      ];
      expect(args.include).toEqual(INCLUDE);
      // El `createdById` lo omite el cliente de Prisma, no cada consulta.
      expect(args.omit).toBeUndefined();
    }

    it('create y findAll piden el mismo include; la respuesta lleva equipo', async () => {
      prisma.trabajoExtraordinario.create.mockResolvedValue(row);
      prisma.trabajoExtraordinario.findMany.mockResolvedValue([row]);

      const created = await createAs(payload);
      const [listed] = await service.findAll();

      expectQueryShape(prisma.trabajoExtraordinario.create);
      expectQueryShape(prisma.trabajoExtraordinario.findMany);
      expect(created).toHaveProperty('equipo', { internalCode: 'CA-011' });
      expect(Object.keys(created).sort()).toEqual(Object.keys(listed).sort());
    });

    it('el replay idempotente usa la misma forma de query que create', async () => {
      prisma.trabajoExtraordinario.findUnique
        .mockResolvedValueOnce({ createdById: USER_ID })
        .mockResolvedValueOnce(row);

      const res = await createAs(payload);

      expectQueryShape(prisma.trabajoExtraordinario.findUnique, 1);
      expect(res).toHaveProperty('equipo', { internalCode: 'CA-011' });
    });

    it('la relectura tras P2002 usa la misma forma de query que create', async () => {
      prisma.trabajoExtraordinario.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ createdById: USER_ID })
        .mockResolvedValueOnce(row);
      prisma.trabajoExtraordinario.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['id'] },
        }),
      );

      const res = await createAs(payload);

      expectQueryShape(prisma.trabajoExtraordinario.findUnique, 2);
      expect(res).toHaveProperty('equipo', { internalCode: 'CA-011' });
    });

    it('findOne pide el mismo include', async () => {
      prisma.trabajoExtraordinario.findUnique.mockResolvedValue(row);

      await service.findOne(ID);

      expectQueryShape(prisma.trabajoExtraordinario.findUnique);
    });

    it('el chequeo de propiedad solo lee createdById: la fila completa sale por findOne', async () => {
      prisma.trabajoExtraordinario.findUnique
        .mockResolvedValueOnce({ createdById: USER_ID })
        .mockResolvedValueOnce(row);

      await createAs(payload);

      const [ownerQuery] = prisma.trabajoExtraordinario.findUnique.mock
        .calls[0] as [{ where: unknown; select: unknown }];
      expect(ownerQuery).toEqual({
        where: { id: ID },
        select: { createdById: true },
      });
    });
  });
});

// O2-equivalente para Trabajos extra: `operatorId` es obligatorio y
// `operador` sale del DTO — con `forbidNonWhitelisted: true` global, mandar
// `operador` en el body es un 400. Mismo patrón que el bloque
// `CreateHorometroDto — límites` de `horometro.service.spec.ts`.
describe('CreateTrabajoExtraDto — operatorId obligatorio, operador fuera del DTO', () => {
  const base = {
    equipoId: 'e1',
    operatorId: 'op_1',
    faena: 'Rajo Norte',
    turno: 'DIURNO',
    horometroInicial: 1200,
    horometroFinal: 1212,
    actividades: ['REGULACION_CARGA'],
    descripcion: 'Carga de material',
  };

  it('acepta el body con operatorId', async () => {
    const dto = plainToInstance(CreateTrabajoExtraDto, base);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza si falta operatorId', async () => {
    const dto = plainToInstance(CreateTrabajoExtraDto, {
      equipoId: base.equipoId,
      faena: base.faena,
      turno: base.turno,
      horometroInicial: base.horometroInicial,
      horometroFinal: base.horometroFinal,
      actividades: base.actividades,
      descripcion: base.descripcion,
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza operatorId vacío', async () => {
    const dto = plainToInstance(CreateTrabajoExtraDto, {
      ...base,
      operatorId: '',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza el body si manda operador — forbidNonWhitelisted lo tumba', async () => {
    const dto = plainToInstance(CreateTrabajoExtraDto, {
      ...base,
      operador: 'Juan Rojas',
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
