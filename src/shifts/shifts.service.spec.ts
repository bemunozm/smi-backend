import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';

import { ChangeLogService } from '../change-log/change-log.service';
import { AdBlueStockService } from '../inventory/adblue-stock.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { buildSession, prismaError } from '../common/testing/fixtures';
import { OperatorsService } from '../operators/operators.service';
import { StorageService } from '../storage/storage.service';
import { CloseShiftCardDto } from './dto/close-shift-card.dto';
import { CreateShiftCardFuelLoadDto } from './dto/create-shift-card-fuel-load.dto';
import { OpenShiftCardDto } from './dto/open-shift-card.dto';
import { ShiftsService, primerRolConocido } from './shifts.service';
import {
  businessDayKey,
  businessHour,
  todayInBusinessTimeZone,
} from '../common/dates/business-time';
import {
  formatDateOnly,
  fuelDateForShiftDay,
  parseDateOnlyUtc,
} from './date-only';

/**
 * Captura el `data` de la ÚLTIMA llamada a un mock `jest.fn()` sin tipar.
 * Evita mezclar `expect.objectContaining()` DENTRO de un objeto literal
 * pasado a `toHaveBeenCalledWith` — eso dispara
 * `@typescript-eslint/no-unsafe-assignment` (mismo problema documentado en
 * `horometro.service.spec.ts`). Se captura el argumento real y se afirma
 * campo por campo en su lugar.
 */
function lastCallData(mockFn: jest.Mock): Record<string, unknown> {
  const calls = mockFn.mock.calls as unknown as Array<
    [{ data: Record<string, unknown> }]
  >;
  const [{ data }] = calls[calls.length - 1];
  return data;
}

/** `capturedAt` relativo a "ahora" — evita que los tests dependan de la
 * fecha real del reloj de la máquina que corre Jest (`assertReasonableCapturedAt`
 * compara contra `Date.now()`). */
function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** `shiftDate` relativo a "hoy" (mismo motivo que `iso()`, pero para
 * `assertShiftDateWithinWindow` — compara contra `new Date()` real).
 * `offsetDays` en días de CALENDARIO, no ms. */
function todayShiftDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Medianoche UTC del mismo día que devuelve `todayShiftDate()` — para
 * armar el `Date` que `ShiftsService.upsertShift` construye internamente a
 * partir de `dto.shiftDate` (mismo criterio que `parseDateOnlyUtc`). */
function todayShiftDateUtc(offsetDays = 0): Date {
  return new Date(`${todayShiftDate(offsetDays)}T00:00:00.000Z`);
}

/** Instante reciente (≤24 h atrás, dentro de la ventana de `capturedAt`) cuya
 * hora CHILENA es `hour` — independiente de la hora a la que corra Jest. */
function instantAtBusinessHour(hour: number): Date {
  const horasAtras = (businessHour(new Date()) - hour + 24) % 24;
  return new Date(Date.now() - horasAtras * 3_600_000);
}

/** El día de negocio chileno ANTERIOR al del instante dado (`YYYY-MM-DD`). */
function previousBusinessDay(at: Date): string {
  const dia = parseDateOnlyUtc(todayInBusinessTimeZone(at));
  dia.setUTCDate(dia.getUTCDate() - 1);
  return formatDateOnly(dia);
}

const EQUIPO_INCLUDE = {
  internalCode: 'EX-001',
  type: 'Excavadora',
  controlUnit: 'HOURS',
  equipmentClass: 'HEAVY',
};

function buildCardRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'card_1',
    equipoId: 'e1',
    valorInicial: 100,
    valorFinal: null,
    turno: 'DIURNO',
    operador: 'Patricio Rojas',
    operatorId: 'op_1',
    supervisorId: 'sup_1',
    shiftId: 'shift_1',
    fecha: new Date('2026-09-28T08:00:00.000Z'),
    fechaSalida: null,
    fuelLiters: null,
    pumpPhotoKey: null,
    observaciones: null,
    closeClientId: null,
    adBlue: false,
    adBlueLiters: null,
    belowPreviousReading: false,
    createdAt: new Date('2026-09-28T08:00:00.000Z'),
    closedAt: null,
    clientClockSkewMs: null,
    nivelCombustible: null,
    equipo: EQUIPO_INCLUDE,
    cargasEnCurso: [] as unknown[],
    shift: {
      id: 'shift_1',
      date: new Date('2026-09-28T00:00:00.000Z'),
      type: 'DIURNO',
      exitReports: [],
    },
    ...overrides,
  };
}

/** Una carga registrada con la tarjeta abierta, como la lee el include. */
const CARGA_EN_CURSO = {
  id: 'carga_1',
  litros: 40,
  lectura: 1250,
  adBlueLitros: null,
  fotoKey: 'fuel-photos/c1.jpg',
  fecha: new Date('2026-09-28T15:00:00.000Z'),
  createdAt: new Date('2026-09-28T15:00:00.000Z'),
  createdById: 'sup_2',
};

describe('ShiftsService', () => {
  let service: ShiftsService;

  // `openCard()`/`closeCard()` corren dentro de `$transaction`: las lecturas
  // y escrituras deben pasar por el `tx` que recibe el callback, nunca por
  // el cliente `prisma` de nivel superior. `resolveOpenRace`/`resolveCloseRace`
  // (fuera de la tx, tras un rollback) sí usan `prisma` directo — de ahí el
  // doble mock, mismo patrón que `horometro.service.spec.ts`.
  const tx = {
    registroHorometro: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      // Lecturas que quedan del equipo al corregir/borrar una (contador).
      aggregate: jest.fn(),
    },
    equipment: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    registroCombustible: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      aggregate: jest.fn(),
      count: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    // Turno de quien cerró un liviano (`closedShiftId`, soft ref): lo
    // resuelve `syncFuelRecord` para fechar la carga editada.
    shift: { findUnique: jest.fn() },
    // Checklist diario del equipo (Módulo 3): sin fila, el equipo está libre.
    dailyChecklist: { findUnique: jest.fn() },
    // Bloqueo de la fila (`FOR UPDATE`) al editar una tarjeta.
    $queryRaw: jest.fn(),
  };

  const prisma = {
    registroHorometro: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    // Carga vinculada de una tarjeta a eliminar (`removeCard`, fuera de tx).
    registroCombustible: { findUnique: jest.fn() },
    shift: { upsert: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    // Pre-check de solo lectura del equipo, ANTES del upsert del `Shift`
    // (que sí escribe) — ver `ShiftsService.openCard`.
    equipment: { findUnique: jest.fn() },
    // Checklist diario del equipo (Módulo 3): sin fila, el equipo está libre.
    dailyChecklist: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };

  const claimTmp = jest.fn();
  const sign = jest.fn();
  const discard = jest.fn();
  const deleteBestEffort = jest.fn();
  const assertActive = jest.fn();
  const changeLog = { record: jest.fn(), findFor: jest.fn() };
  const eventEmitter = { emit: jest.fn() };
  const adBlueStock = {
    discountLoad: jest.fn(),
    restoreLoad: jest.fn(),
    emitPending: jest.fn(),
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        ShiftsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: { claimTmp, sign, discard, deleteBestEffort },
        },
        { provide: OperatorsService, useValue: { assertActive } },
        { provide: ChangeLogService, useValue: changeLog },
        { provide: AdBlueStockService, useValue: adBlueStock },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();
    service = mod.get(ShiftsService);
    jest.clearAllMocks();

    assertActive.mockResolvedValue({
      id: 'op_1',
      name: 'Patricio Rojas',
      isActive: true,
    });
    prisma.shift.upsert.mockResolvedValue({
      id: 'shift_1',
      supervisorId: 'sup_1',
      date: new Date('2026-09-28T00:00:00.000Z'),
      type: 'DIURNO',
    });
    prisma.$transaction.mockImplementation(
      (cb: (client: typeof tx) => unknown) => cb(tx),
    );

    tx.registroHorometro.findUnique.mockResolvedValue(null);
    tx.registroHorometro.findFirst.mockResolvedValue(null);
    tx.equipment.findUnique.mockResolvedValue({
      status: 'OPERATIONAL',
      controlUnit: 'HOURS',
      currentHourmeter: null,
      currentMileage: null,
    });
    tx.equipment.updateMany.mockResolvedValue({ count: 1 });
    // Pre-check de solo lectura ANTES del upsert del `Shift`, ver
    // `ShiftsService.openCard` — por defecto pasa, los tests de equipo no operativo/404 lo
    // sobreescriben.
    prisma.equipment.findUnique.mockResolvedValue({ status: 'OPERATIONAL' });
    tx.registroHorometro.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        buildCardRecord({ ...data, id: data.id as string }),
    );
    tx.registroHorometro.updateMany.mockResolvedValue({ count: 1 });
    tx.registroHorometro.aggregate.mockResolvedValue({
      _max: { valorInicial: null, valorFinal: null },
    });
    tx.registroCombustible.aggregate.mockResolvedValue({
      _max: { lectura: null },
    });
    // Sin cargas registradas con la tarjeta abierta.
    tx.registroCombustible.count.mockResolvedValue(0);
    // La carga nacida del cierre (su id va en el aviso `fuel.loaded`).
    tx.registroCombustible.create.mockResolvedValue({ id: 'carga_cierre' });

    sign.mockImplementation((key: string) =>
      Promise.resolve(`https://signed/${key}`),
    );
    prisma.user.findMany.mockResolvedValue([]);
  });

  describe('openCard', () => {
    const session = buildSession('sup_1');
    const dto: OpenShiftCardDto = {
      id: 'card_1',
      equipoId: 'e1',
      operatorId: 'op_1',
      valorInicial: 100,
      shiftDate: todayShiftDate(),
      shiftType: 'DIURNO',
      capturedAt: iso(),
    };

    it('valida el operador, hace upsert del turno y crea la tarjeta con supervisorId/operatorId/shiftId', async () => {
      const result = await service.openCard(dto, session);

      expect(assertActive).toHaveBeenCalledWith('op_1');
      expect(lastCallData(tx.registroHorometro.create)).toMatchObject({
        id: 'card_1',
        equipoId: 'e1',
        operatorId: 'op_1',
        operador: 'Patricio Rojas',
        supervisorId: 'sup_1',
        shiftId: 'shift_1',
      });
      expect(result.id).toBe('card_1');
    });

    it('liviano: se abre sin operador (la camioneta la maneja el supervisor)', async () => {
      prisma.equipment.findUnique.mockResolvedValueOnce({
        status: 'OPERATIONAL',
        equipmentClass: 'LIGHT',
      });

      await service.openCard({ ...dto, operatorId: undefined }, session);

      expect(assertActive).not.toHaveBeenCalled();
      expect(lastCallData(tx.registroHorometro.create)).toMatchObject({
        operador: '',
        operatorId: null,
        supervisorId: 'sup_1',
      });
    });

    it('mantenedor: abre la camioneta que usa, pero no un pesado', async () => {
      const mantenedor = {
        ...session,
        user: { ...session.user, id: 'mant_1', role: 'MANTENEDOR' },
      } as typeof session;
      prisma.equipment.findUnique.mockResolvedValueOnce({
        status: 'OPERATIONAL',
        equipmentClass: 'HEAVY',
      });
      await expect(service.openCard(dto, mantenedor)).rejects.toThrow(
        'Solo puedes registrar el uso de vehículos livianos',
      );

      prisma.equipment.findUnique.mockResolvedValueOnce({
        status: 'OPERATIONAL',
        equipmentClass: 'LIGHT',
      });
      await service.openCard({ ...dto, operatorId: undefined }, mantenedor);
      expect(lastCallData(tx.registroHorometro.create)).toMatchObject({
        supervisorId: 'mant_1',
        operatorId: null,
      });
    });

    it('prevencionista: igual que el mantenedor, solo camionetas', async () => {
      const prevencionista = {
        ...session,
        user: { ...session.user, id: 'prev_1', role: 'PREVENCIONISTA' },
      } as typeof session;
      prisma.equipment.findUnique.mockResolvedValueOnce({
        status: 'OPERATIONAL',
        equipmentClass: 'HEAVY',
      });
      await expect(service.openCard(dto, prevencionista)).rejects.toThrow(
        'Solo puedes registrar el uso de vehículos livianos',
      );

      prisma.equipment.findUnique.mockResolvedValueOnce({
        status: 'OPERATIONAL',
        equipmentClass: 'LIGHT',
      });
      await service.openCard({ ...dto, operatorId: undefined }, prevencionista);
      expect(lastCallData(tx.registroHorometro.create)).toMatchObject({
        supervisorId: 'prev_1',
        operatorId: null,
      });
    });

    it('pesado: sin operador no se abre', async () => {
      prisma.equipment.findUnique.mockResolvedValueOnce({
        status: 'OPERATIONAL',
        equipmentClass: 'HEAVY',
      });

      await expect(
        service.openCard({ ...dto, operatorId: undefined }, session),
      ).rejects.toThrow('Elige el operador');
      expect(tx.registroHorometro.create).not.toHaveBeenCalled();
    });

    it('cuadra el contador del equipo a valorInicial cuando no está por debajo del vigente', async () => {
      await service.openCard(dto, session);

      expect(tx.equipment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'e1',
          OR: [{ currentHourmeter: null }, { currentHourmeter: { lt: 100 } }],
        },
        data: { currentHourmeter: 100 },
      });
    });

    it('el upsert del turno usa la clave natural (supervisorId, date, type) y ocurre ANTES de la transacción', async () => {
      const callOrder: string[] = [];
      prisma.shift.upsert.mockImplementation(() => {
        callOrder.push('upsertShift');
        return Promise.resolve({
          id: 'shift_1',
          supervisorId: 'sup_1',
          date: todayShiftDateUtc(),
          type: 'DIURNO',
        });
      });
      prisma.$transaction.mockImplementation(
        (cb: (client: typeof tx) => unknown) => {
          callOrder.push('transaction');
          return cb(tx);
        },
      );

      await service.openCard(dto, session);

      expect(callOrder).toEqual(['upsertShift', 'transaction']);
      expect(prisma.shift.upsert).toHaveBeenCalledWith({
        where: {
          supervisorId_date_type: {
            supervisorId: 'sup_1',
            date: todayShiftDateUtc(),
            type: 'DIURNO',
          },
        },
        create: {
          supervisorId: 'sup_1',
          date: todayShiftDateUtc(),
          type: 'DIURNO',
        },
        update: {},
      });
    });

    it('replay: mismo id, mismo supervisor y mismo equipo → devuelve la existente SIN crear', async () => {
      tx.registroHorometro.findUnique.mockResolvedValue(
        buildCardRecord({
          id: 'card_1',
          supervisorId: 'sup_1',
          equipoId: 'e1',
        }),
      );

      const result = await service.openCard(dto, session);

      expect(tx.registroHorometro.create).not.toHaveBeenCalled();
      expect(result.id).toBe('card_1');
    });

    it('ID_CONFLICT: mismo id pero para otro equipo/supervisor → 409', async () => {
      tx.registroHorometro.findUnique.mockResolvedValue(
        buildCardRecord({
          id: 'card_1',
          supervisorId: 'otro_sup',
          equipoId: 'e1',
        }),
      );

      expect.assertions(2);
      try {
        await service.openCard(dto, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'ID_CONFLICT',
        });
      }
    });

    it('EQUIPMENT_NOT_OPERATIONAL: 409 si el equipo no está operativo', async () => {
      tx.equipment.findUnique.mockResolvedValue({
        status: 'IN_WORKSHOP',
        controlUnit: 'HOURS',
        currentHourmeter: null,
        currentMileage: null,
      });

      expect.assertions(3);
      try {
        await service.openCard(dto, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'EQUIPMENT_NOT_OPERATIONAL',
        });
        expect(tx.registroHorometro.create).not.toHaveBeenCalled();
      }
    });

    it('CHECKLIST_NOT_ACCEPTED: 409 si el checklist del día está por validar (Módulo 3)', async () => {
      prisma.dailyChecklist.findUnique.mockResolvedValueOnce({
        status: 'SUBMITTED',
      });

      expect.assertions(3);
      try {
        await service.openCard(dto, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'CHECKLIST_NOT_ACCEPTED',
        });
        // Se corta antes de escribir el `Shift`.
        expect(prisma.shift.upsert).not.toHaveBeenCalled();
      }
    });

    it('EQUIPMENT_BUSY: 409 si el equipo ya tiene otra tarjeta abierta, con quién y desde cuándo', async () => {
      tx.registroHorometro.findFirst.mockResolvedValue({
        supervisorId: 'otro_sup',
        fecha: new Date('2026-09-28T06:00:00.000Z'),
      });
      tx.user.findUnique.mockResolvedValue({ name: 'Ana Torres' });

      expect.assertions(3);
      try {
        await service.openCard(dto, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'EQUIPMENT_BUSY',
        });
        expect((error as ConflictException).message).toContain('Ana Torres');
      }
    });

    it('P2002 en el create: si la tarjeta releída afuera es mía, la devuelve (200)', async () => {
      tx.registroHorometro.create.mockImplementation(() => {
        throw prismaError('P2002');
      });
      prisma.registroHorometro.findUnique.mockResolvedValue(
        buildCardRecord({
          id: 'card_1',
          supervisorId: 'sup_1',
          equipoId: 'e1',
        }),
      );

      const result = await service.openCard(dto, session);

      expect(result.id).toBe('card_1');
      // Solo el `findUnique` inicial (el chequeo de replay) corrió DENTRO de
      // la tx — ninguna consulta extra tras el P2002, la tx quedó abortada.
      expect(tx.registroHorometro.findUnique).toHaveBeenCalledTimes(1);
    });

    it('P2002 en el create: si no es mía afuera, 409 EQUIPMENT_BUSY', async () => {
      tx.registroHorometro.create.mockImplementation(() => {
        throw prismaError('P2002');
      });
      prisma.registroHorometro.findUnique.mockResolvedValue(null);
      prisma.registroHorometro.findFirst.mockResolvedValue({
        supervisorId: 'otro_sup',
        fecha: new Date('2026-09-28T06:00:00.000Z'),
      });
      prisma.user.findUnique.mockResolvedValue({ name: 'Ana Torres' });

      expect.assertions(2);
      try {
        await service.openCard(dto, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'EQUIPMENT_BUSY',
        });
      }
    });

    it('modo warn: valorInicial menor que el contador vigente → belowPreviousReading true y el contador NO se mueve', async () => {
      tx.equipment.findUnique.mockResolvedValue({
        status: 'OPERATIONAL',
        controlUnit: 'HOURS',
        currentHourmeter: 500,
        currentMileage: null,
      });

      const result = await service.openCard(dto, session);

      expect(
        lastCallData(tx.registroHorometro.create).belowPreviousReading,
      ).toBe(true);
      expect(tx.equipment.updateMany).not.toHaveBeenCalled();
      expect(result.belowPreviousReading).toBe(true);
    });

    it('OPERATOR_INACTIVE: propaga el rechazo de OperatorsService sin llegar al upsert del turno ni a la tx', async () => {
      assertActive.mockRejectedValue(
        new ConflictException({
          message: 'El operador "Patricio Rojas" está inactivo',
          code: 'OPERATOR_INACTIVE',
        }),
      );

      await expect(service.openCard(dto, session)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.shift.upsert).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    describe('pre-check del equipo ANTES del upsert del Shift', () => {
      it('404 si el equipo no existe — no llega a crear el Shift ni a la tx', async () => {
        prisma.equipment.findUnique.mockResolvedValue(null);

        await expect(service.openCard(dto, session)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(prisma.shift.upsert).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('409 EQUIPMENT_NOT_OPERATIONAL en el pre-check si el equipo está en taller — tampoco crea el Shift', async () => {
        prisma.equipment.findUnique.mockResolvedValue({
          status: 'IN_WORKSHOP',
        });

        expect.assertions(4);
        try {
          await service.openCard(dto, session);
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(ConflictException);
          expect((error as ConflictException).getResponse()).toMatchObject({
            code: 'EQUIPMENT_NOT_OPERATIONAL',
          });
        }
        expect(prisma.shift.upsert).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('turno de un día pasado (carga histórica)', () => {
      // −2 días: estrictamente anterior al día de negocio chileno sin
      // importar el huso de la máquina que corre Jest (−1 es ambiguo entre
      // ~21:00 y medianoche de Chile).
      const pasado = todayShiftDate(-2);

      it('equipo no operativo NO bloquea la apertura de un día pasado', async () => {
        prisma.equipment.findUnique.mockResolvedValue({
          status: 'IN_WORKSHOP',
        });
        tx.equipment.findUnique.mockResolvedValue({
          status: 'IN_WORKSHOP',
          controlUnit: 'HOURS',
          currentHourmeter: null,
          currentMileage: null,
        });

        await service.openCard({ ...dto, shiftDate: pasado }, session);

        expect(tx.registroHorometro.create).toHaveBeenCalled();
      });

      it('la tarjeta de un día pasado se fecha dentro de ese día de negocio', async () => {
        await service.openCard({ ...dto, shiftDate: pasado }, session);

        const data = lastCallData(tx.registroHorometro.create);
        expect(businessDayKey(data.fecha as Date)).toBe(pasado);
      });

      it('NOCTURNO pasado: el instante cae en la tarde de ese día (20:30 −03)', async () => {
        await service.openCard(
          { ...dto, shiftDate: pasado, shiftType: 'NOCTURNO' },
          session,
        );

        const data = lastCallData(tx.registroHorometro.create);
        expect(businessDayKey(data.fecha as Date)).toBe(pasado);
        expect((data.fecha as Date).toISOString()).toBe(
          `${pasado}T23:30:00.000Z`,
        );
      });

      it('shiftDate de HOY: el equipo no operativo sigue bloqueando (409)', async () => {
        prisma.equipment.findUnique.mockResolvedValue({
          status: 'IN_WORKSHOP',
        });

        await expect(service.openCard(dto, session)).rejects.toMatchObject({
          response: { code: 'EQUIPMENT_NOT_OPERATIONAL' },
        });
      });

      it('día pasado + tarjeta abierta del equipo → sigue 409 EQUIPMENT_BUSY', async () => {
        tx.registroHorometro.findFirst.mockResolvedValue({
          supervisorId: 'otro_sup',
          fecha: new Date('2026-09-28T06:00:00.000Z'),
        });
        tx.user.findUnique.mockResolvedValue({ name: 'Ana Torres' });

        await expect(
          service.openCard({ ...dto, shiftDate: pasado }, session),
        ).rejects.toMatchObject({ response: { code: 'EQUIPMENT_BUSY' } });
      });

      /**
       * Antes de las 08:00 el frontend VIVO manda `shiftDate` de ayer
       * (`fechaDeTurno`): el NOCTURNO que corre desde anoche NO es carga
       * histórica aunque su día de negocio ya haya pasado. Sin esta
       * distinción, un equipo agregado al turno a las 02:00 se saltaría el
       * guard de "no operativo" y quedaría fechado sintético a las 20:30 de
       * ayer (y su cierre de las 07:00, también).
       */
      describe('madrugada: el NOCTURNO vivo de anoche no es carga histórica', () => {
        // 05:00Z del 02-11 = 02:00 en Chile (UTC-3 en noviembre) → el
        // nocturno vigente es el del 2026-11-01.
        const MADRUGADA = new Date('2026-11-02T05:00:00.000Z');
        const NOCTURNO_ANOCHE = {
          shiftDate: '2026-11-01',
          shiftType: 'NOCTURNO' as const,
        };

        beforeEach(() => {
          jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
          jest.setSystemTime(MADRUGADA);
        });
        afterEach(() => jest.useRealTimers());

        it('a las 02:00, equipo no operativo → sigue 409 (flujo vivo)', async () => {
          prisma.equipment.findUnique.mockResolvedValue({
            status: 'IN_WORKSHOP',
          });

          await expect(
            service.openCard(
              { ...dto, ...NOCTURNO_ANOCHE, capturedAt: iso() },
              session,
            ),
          ).rejects.toMatchObject({
            response: { code: 'EQUIPMENT_NOT_OPERATIONAL' },
          });
        });

        it('a las 02:00, la tarjeta se fecha con la hora REAL de captura, no sintética', async () => {
          const capturedAt = iso();
          await service.openCard(
            { ...dto, ...NOCTURNO_ANOCHE, capturedAt },
            session,
          );

          const data = lastCallData(tx.registroHorometro.create);
          expect((data.fecha as Date).toISOString()).toBe(
            new Date(capturedAt).toISOString(),
          );
        });

        it('a las 10:00 ese nocturno YA terminó: vuelve a ser carga histórica (fecha sintética)', async () => {
          jest.setSystemTime(new Date('2026-11-02T13:00:00.000Z')); // 10:00 Chile
          prisma.equipment.findUnique.mockResolvedValue({
            status: 'IN_WORKSHOP',
          });
          tx.equipment.findUnique.mockResolvedValue({
            status: 'IN_WORKSHOP',
            controlUnit: 'HOURS',
            currentHourmeter: null,
            currentMileage: null,
          });

          await service.openCard(
            { ...dto, ...NOCTURNO_ANOCHE, capturedAt: iso() },
            session,
          );

          const data = lastCallData(tx.registroHorometro.create);
          expect((data.fecha as Date).toISOString()).toBe(
            '2026-11-01T23:30:00.000Z',
          );
        });
      });
    });

    describe('ventana de shiftDate', () => {
      it('rechaza un shiftDate de más de 30 días de antigüedad con INVALID_SHIFT_DATE, antes de crear el Shift', async () => {
        expect.assertions(4);
        try {
          const shiftDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10);
          await service.openCard({ ...dto, shiftDate }, session);
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(BadRequestException);
          expect((error as BadRequestException).getResponse()).toMatchObject({
            code: 'INVALID_SHIFT_DATE',
          });
        }
        expect(prisma.shift.upsert).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('rechaza un shiftDate de más de 1 día a futuro', async () => {
        const now = new Date();
        const farFuture = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        const shiftDate = farFuture.toISOString().slice(0, 10);

        await expect(
          service.openCard({ ...dto, shiftDate }, session),
        ).rejects.toMatchObject({
          response: { code: 'INVALID_SHIFT_DATE' },
        });
      });
    });

    it('un capturedAt más de 24h en el futuro no rechaza: la tarjeta se abre con la hora del servidor y deja el desfase', async () => {
      const antes = Date.now();
      await service.openCard(
        { ...dto, capturedAt: iso(25 * 60 * 60 * 1000) },
        session,
      );

      const data = lastCallData(tx.registroHorometro.create);
      expect((data.fecha as Date).getTime()).toBeGreaterThanOrEqual(antes);
      expect((data.fecha as Date).getTime()).toBeLessThanOrEqual(Date.now());
      expect(data.clientClockSkewMs).toBeLessThan(-24 * 60 * 60 * 1000);
    });

    it('un capturedAt de más de 7 días de antigüedad no rechaza: usa la hora del servidor y deja el desfase', async () => {
      const antes = Date.now();
      await service.openCard(
        { ...dto, capturedAt: iso(-8 * 24 * 60 * 60 * 1000) },
        session,
      );

      const data = lastCallData(tx.registroHorometro.create);
      expect((data.fecha as Date).getTime()).toBeGreaterThanOrEqual(antes);
      expect(data.clientClockSkewMs).toBeGreaterThan(7 * 24 * 60 * 60 * 1000);
    });

    it('el header X-Client-Time manda sobre el desfase derivado de capturedAt', async () => {
      await service.openCard(
        { ...dto, capturedAt: iso(-8 * 24 * 60 * 60 * 1000) },
        session,
        iso(-5000),
      );

      const data = lastCallData(tx.registroHorometro.create);
      expect(data.clientClockSkewMs).toBeGreaterThanOrEqual(5000);
      expect(data.clientClockSkewMs).toBeLessThan(60_000);
    });

    it('un capturedAt con formato inválido sigue siendo 400 INVALID_CAPTURE_TIME, antes de validar el operador', async () => {
      expect.assertions(3);
      try {
        await service.openCard({ ...dto, capturedAt: '2026-W01' }, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'INVALID_CAPTURE_TIME',
        });
      }
      expect(assertActive).not.toHaveBeenCalled();
    });

    it('no rechaza por desfase razonable (ej. 2 días de antigüedad, offline)', async () => {
      await expect(
        service.openCard(
          { ...dto, capturedAt: iso(-2 * 24 * 60 * 60 * 1000) },
          session,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('adminCloseCard', () => {
    const admin = buildSession('adm_1', 'ADMIN', 'Joaquín Admin');
    const abierta = {
      equipoId: 'e1',
      valorInicial: 14676.7,
      valorFinal: null,
      closedAt: null,
      observaciones: null,
      belowPreviousReading: false,
    };

    beforeEach(() => {
      prisma.registroHorometro.findUnique
        .mockResolvedValueOnce(abierta)
        .mockResolvedValueOnce(
          buildCardRecord({ id: 'card_1', valorFinal: 14676.7 }),
        );
      tx.equipment.findUnique.mockResolvedValue({
        controlUnit: 'HOURS',
        currentHourmeter: 14676.7,
        currentMileage: null,
      });
    });

    it('cierra sin foto ni combustible, deja la nota y suelta la asignación del equipo', async () => {
      await service.adminCloseCard(
        'card_1',
        { valorFinal: 14676.7, motivo: 'equipo fuera de servicio' },
        admin,
      );

      expect(claimTmp).not.toHaveBeenCalled();
      expect(tx.registroCombustible.create).not.toHaveBeenCalled();
      expect(tx.registroHorometro.updateMany).toHaveBeenCalledWith({
        where: { id: 'card_1', valorFinal: null },
        data: expect.objectContaining({
          valorFinal: 14676.7,
          closedById: 'adm_1',
          closedByName: 'Joaquín Admin',
          observaciones:
            'Cerrada por la administración (Joaquín Admin): equipo fuera de servicio.',
        }) as unknown,
      });
      expect(tx.equipment.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { currentOperatorId: null, currentSupervisorId: null },
      });
    });

    it('rechaza una lectura final menor que la inicial', async () => {
      await expect(
        service.adminCloseCard('card_1', { valorFinal: 100 }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.registroHorometro.updateMany).not.toHaveBeenCalled();
    });

    it('una tarjeta ya cerrada da 409 ALREADY_CLOSED', async () => {
      prisma.registroHorometro.findUnique.mockReset();
      prisma.registroHorometro.findUnique.mockResolvedValue({
        ...abierta,
        valorFinal: 14680,
        closedAt: new Date('2026-11-13T23:00:00.000Z'),
      });

      await expect(
        service.adminCloseCard('card_1', { valorFinal: 14680 }, admin),
      ).rejects.toMatchObject({
        response: { code: 'ALREADY_CLOSED' },
      });
    });
  });

  describe('closeCard', () => {
    const session = buildSession('sup_1');
    const dto: CloseShiftCardDto = {
      closeClientId: 'close_1',
      valorFinal: 130,
      fuelLiters: 150,
      tmpPhotoKey: 'tmp/sup_1/11111111-1111-4111-8111-111111111111.jpg',
      capturedAt: iso(),
    };

    beforeEach(() => {
      prisma.registroHorometro.findUnique.mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: null,
        supervisorId: 'sup_1',
        closeClientId: null,
        closedAt: null,
      });
      claimTmp.mockResolvedValue('fuel-photos/final.jpg');
      tx.equipment.findUnique.mockResolvedValue({
        controlUnit: 'HOURS',
        currentHourmeter: 100,
        currentMileage: null,
      });
      tx.registroHorometro.findUnique.mockResolvedValue(
        buildCardRecord({
          id: 'card_1',
          valorFinal: 130,
          fuelLiters: 150,
          pumpPhotoKey: 'fuel-photos/final.jpg',
          closeClientId: 'close_1',
        }),
      );
    });

    it('CARD_NOT_FOUND: 404 con code si la tarjeta no existe (ej. el open original nunca llegó al servidor — el outbox offline clasifica por code)', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue(null);

      expect.assertions(2);
      try {
        await service.closeCard('card_inexistente', dto, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).getResponse()).toMatchObject({
          code: 'CARD_NOT_FOUND',
        });
      }
    });

    it('sin combustible (corte de luz) se cierra sin foto: no reclama nada ni crea carga', async () => {
      const sinCarga = {
        ...dto,
        fuelLiters: 0,
        tmpPhotoKey: undefined,
        noFuelReason: 'Corte de luz',
      };

      await service.closeCard('card_1', sinCarga, session);

      expect(claimTmp).not.toHaveBeenCalled();
      expect(tx.registroCombustible.create).not.toHaveBeenCalled();
      expect(lastCallData(tx.registroHorometro.updateMany)).toMatchObject({
        valorFinal: 130,
        fuelLiters: 0,
        pumpPhotoKey: null,
        noFuelReason: 'Corte de luz',
      });
    });

    it('con litros cargados el motivo sin carga se descarta', async () => {
      await service.closeCard(
        'card_1',
        { ...dto, noFuelReason: 'Corte de luz' },
        session,
      );

      expect(lastCallData(tx.registroHorometro.updateMany)).toMatchObject({
        noFuelReason: null,
      });
    });

    it('con litros cargados la foto del surtidor sigue siendo obligatoria (400 FUEL_PHOTO_REQUIRED)', async () => {
      await expect(
        service.closeCard(
          'card_1',
          { ...dto, tmpPhotoKey: undefined },
          session,
        ),
      ).rejects.toMatchObject({
        response: { code: 'FUEL_PHOTO_REQUIRED' },
      });
      expect(claimTmp).not.toHaveBeenCalled();
      expect(tx.registroHorometro.updateMany).not.toHaveBeenCalled();
    });

    it('cierra la tarjeta, reclama la foto y crea el RegistroCombustible vinculado con la MISMA key', async () => {
      const result = await service.closeCard('card_1', dto, session);

      expect(claimTmp).toHaveBeenCalledWith(
        'tmp/sup_1/11111111-1111-4111-8111-111111111111.jpg',
        'sup_1',
        'fuel-photo',
      );
      expect(lastCallData(tx.registroCombustible.create)).toMatchObject({
        equipoId: 'e1',
        litros: 150,
        fotoKey: 'fuel-photos/final.jpg',
        registroHorometroId: 'card_1',
      });
      expect(result.pumpPhotoUrl).toBe('https://signed/fuel-photos/final.jpg');
    });

    describe('cierre de una tarjeta de carga histórica (día pasado)', () => {
      const pasado = todayShiftDate(-2);
      // 12:00 −03 de ese día — el instante que dejó la apertura backfilleada.
      const fechaHistorica = new Date(`${pasado}T15:00:00.000Z`);
      const cardBase = {
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: null,
        turno: 'NOCTURNO',
        supervisorId: 'sup_1',
        closeClientId: null,
        closedAt: null,
        clientClockSkewMs: null,
        belowPreviousReading: false,
      };

      it('fechaSalida y el combustible caen en el día histórico de la tarjeta', async () => {
        prisma.registroHorometro.findUnique.mockResolvedValue({
          ...cardBase,
          fecha: fechaHistorica,
          createdAt: new Date(), // abierta HOY para un día pasado: backfill
        });

        await service.closeCard('card_1', dto, session);

        const update = lastCallData(tx.registroHorometro.updateMany);
        expect((update.fechaSalida as Date).toISOString()).toBe(
          fechaHistorica.toISOString(),
        );
        const fuel = lastCallData(tx.registroCombustible.create);
        expect((fuel.fecha as Date).toISOString()).toBe(
          fechaHistorica.toISOString(),
        );
      });

      it('cierre VIVO de madrugada (antes de las 08:00 de Chile): el combustible cae en el día ANTERIOR y fechaSalida conserva la hora real', async () => {
        const madrugada = instantAtBusinessHour(3);
        prisma.registroHorometro.findUnique.mockResolvedValue({
          ...cardBase,
          fecha: new Date(madrugada.getTime() - 6 * 3_600_000), // abierta ~21:00 de anoche
          createdAt: new Date(madrugada.getTime() - 6 * 3_600_000),
        });

        await service.closeCard(
          'card_1',
          { ...dto, capturedAt: madrugada.toISOString() },
          session,
        );

        const fuel = lastCallData(tx.registroCombustible.create);
        expect((fuel.fecha as Date).toISOString()).toBe(
          `${previousBusinessDay(madrugada)}T23:30:00.000Z`,
        );
        const update = lastCallData(tx.registroHorometro.updateMany);
        expect((update.fechaSalida as Date).toISOString()).toBe(
          madrugada.toISOString(),
        );
      });

      it('cierre PASADAS las 08:00 del día siguiente: el combustible igual cae en el día en que abrió el turno (shift de la tarjeta)', async () => {
        const cierreTarde = instantAtBusinessHour(9); // 09:xx — ya corre el diurno siguiente
        const apertura = new Date(cierreTarde.getTime() - 12 * 3_600_000); // ~21:xx del día del turno
        prisma.registroHorometro.findUnique.mockResolvedValue({
          ...cardBase,
          fecha: apertura,
          createdAt: apertura,
          shift: {
            id: 'shift_1',
            date: parseDateOnlyUtc(previousBusinessDay(cierreTarde)),
            type: 'NOCTURNO',
            exitReports: [],
          },
        });

        await service.closeCard(
          'card_1',
          { ...dto, capturedAt: cierreTarde.toISOString() },
          session,
        );

        const fuel = lastCallData(tx.registroCombustible.create);
        expect((fuel.fecha as Date).toISOString()).toBe(
          `${previousBusinessDay(cierreTarde)}T23:30:00.000Z`,
        );
        const update = lastCallData(tx.registroHorometro.updateMany);
        expect((update.fechaSalida as Date).toISOString()).toBe(
          cierreTarde.toISOString(),
        );
      });

      it('un NOCTURNO vivo de anoche cerrado en la mañana: la SALIDA (fechaSalida) conserva la hora real', async () => {
        // Apertura real hace 11 h: según la hora en que corra Jest cae en
        // ayer (día pasado, pero createdAt de ayer) o en hoy — en ambos
        // casos el cierre es VIVO y conserva la hora real.
        const apertura = new Date(Date.now() - 11 * 3_600_000);
        prisma.registroHorometro.findUnique.mockResolvedValue({
          ...cardBase,
          fecha: apertura,
          createdAt: apertura,
        });

        await service.closeCard('card_1', dto, session);

        const update = lastCallData(tx.registroHorometro.updateMany);
        expect((update.fechaSalida as Date).toISOString()).toBe(
          new Date(dto.capturedAt).toISOString(),
        );
      });
    });

    it('un capturedAt fuera de ventana no rechaza el cierre: fechaSalida es la hora del servidor y se audita el desfase', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: null,
        supervisorId: 'sup_1',
        closeClientId: null,
        closedAt: null,
        clientClockSkewMs: null,
      });
      const antes = Date.now();

      await service.closeCard(
        'card_1',
        { ...dto, capturedAt: iso(-10 * 24 * 60 * 60 * 1000) },
        session,
      );

      const data = lastCallData(tx.registroHorometro.updateMany);
      expect((data.fechaSalida as Date).getTime()).toBeGreaterThanOrEqual(
        antes,
      );
      expect(data.clientClockSkewMs).toBeGreaterThan(9 * 24 * 60 * 60 * 1000);
    });

    it('el desfase del cierre no pisa el que dejó la apertura', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: null,
        supervisorId: 'sup_1',
        closeClientId: null,
        closedAt: null,
        clientClockSkewMs: 1234,
      });

      await service.closeCard(
        'card_1',
        { ...dto, capturedAt: iso(-10 * 24 * 60 * 60 * 1000) },
        session,
      );

      expect(lastCallData(tx.registroHorometro.updateMany)).not.toHaveProperty(
        'clientClockSkewMs',
      );
    });

    it('el contador sube al cerrar con un final por encima del vigente', async () => {
      // Vigente 100 (default del beforeEach), dto.valorFinal 130 → sube.
      await service.closeCard('card_1', dto, session);

      expect(tx.equipment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'e1',
          OR: [{ currentHourmeter: null }, { currentHourmeter: { lt: 130 } }],
        },
        data: { currentHourmeter: 130 },
      });
    });

    it('una tarjeta abierta por debajo del contador (modo warn) cierra OK con un final que SIGUE por debajo — 200, contador sin mover, belowPreviousReading true', async () => {
      // Se abrió con valorInicial 990 cuando el vigente ya era 1000
      // (`belowPreviousReading: true` desde la apertura). Cierra en 998:
      // pasa el `valorFinal >= valorInicial` (998 >= 990), pero SIGUE por
      // debajo del vigente (1000) — el cierre debe reconciliar en modo
      // `'warn'` (nunca `'reject'`), o esta tarjeta quedaría imposible de
      // cerrar (ver comentario de cabecera de `ShiftsService.closeCard`).
      prisma.registroHorometro.findUnique.mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 990,
        valorFinal: null,
        supervisorId: 'sup_1',
        closeClientId: null,
        closedAt: null,
        belowPreviousReading: true,
      });
      tx.equipment.findUnique.mockResolvedValue({
        controlUnit: 'HOURS',
        currentHourmeter: 1000,
        currentMileage: null,
      });
      tx.registroHorometro.findUnique.mockResolvedValue(
        buildCardRecord({
          id: 'card_1',
          valorInicial: 990,
          valorFinal: 998,
          belowPreviousReading: true,
          fuelLiters: 150,
          pumpPhotoKey: 'fuel-photos/final.jpg',
          closeClientId: 'close_1',
        }),
      );

      const result = await service.closeCard(
        'card_1',
        { ...dto, valorFinal: 998 },
        session,
      );

      expect(result.valorFinal).toBe(998);
      expect(result.belowPreviousReading).toBe(true);
      expect(tx.equipment.updateMany).not.toHaveBeenCalled();
      expect(discard).not.toHaveBeenCalled();
    });

    it('warn en el cierre: si la tarjeta NO venía marcada, pero el final queda por debajo del vigente, la marca con un update de seguimiento', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 990,
        valorFinal: null,
        supervisorId: 'sup_1',
        closeClientId: null,
        closedAt: null,
        belowPreviousReading: false,
      });
      tx.equipment.findUnique.mockResolvedValue({
        controlUnit: 'HOURS',
        currentHourmeter: 1000,
        currentMileage: null,
      });

      await service.closeCard('card_1', { ...dto, valorFinal: 998 }, session);

      expect(tx.registroHorometro.update).toHaveBeenCalledWith({
        where: { id: 'card_1' },
        data: { belowPreviousReading: true },
      });
      expect(tx.equipment.updateMany).not.toHaveBeenCalled();
    });

    it('0 L: no crea RegistroCombustible (pero sigue exigiendo la foto)', async () => {
      await service.closeCard('card_1', { ...dto, fuelLiters: 0 }, session);

      expect(claimTmp).toHaveBeenCalled();
      expect(tx.registroCombustible.create).not.toHaveBeenCalled();
    });

    describe('AdBlue al cierre', () => {
      it('persiste AdBlue con sus litros', async () => {
        await service.closeCard(
          'card_1',
          { ...dto, adBlue: true, adBlueLiters: 12.5 },
          session,
        );

        expect(lastCallData(tx.registroHorometro.updateMany)).toMatchObject({
          adBlue: true,
          adBlueLiters: 12.5,
        });
      });

      it('un cierre antiguo sin los campos queda sin AdBlue', async () => {
        await service.closeCard('card_1', dto, session);

        expect(lastCallData(tx.registroHorometro.updateMany)).toMatchObject({
          adBlue: false,
          adBlueLiters: null,
        });
      });

      it('sin AdBlue nunca se guardan litros', async () => {
        await service.closeCard(
          'card_1',
          { ...dto, adBlue: false, adBlueLiters: 9 },
          session,
        );

        expect(lastCallData(tx.registroHorometro.updateMany)).toMatchObject({
          adBlue: false,
          adBlueLiters: null,
        });
      });

      it('la carga declarada descuenta el ítem AdBlue dentro de la transacción del cierre', async () => {
        await service.closeCard(
          'card_1',
          { ...dto, adBlue: true, adBlueLiters: 12.5 },
          session,
        );

        expect(adBlueStock.discountLoad).toHaveBeenCalledWith(
          { tx, events: [] },
          {
            liters: 12.5,
            equipmentId: 'e1',
            performedById: 'sup_1',
            reference: 'card_1',
          },
        );
        // Los avisos de stock bajo salen DESPUÉS de confirmar la transacción.
        expect(adBlueStock.emitPending).toHaveBeenCalledTimes(1);
      });

      it('sin AdBlue no toca el inventario', async () => {
        await service.closeCard('card_1', dto, session);

        expect(adBlueStock.discountLoad).not.toHaveBeenCalled();
      });

      it('la respuesta incluye adBlue y adBlueLiters', async () => {
        tx.registroHorometro.findUnique.mockResolvedValue(
          buildCardRecord({
            id: 'card_1',
            valorFinal: 130,
            adBlue: true,
            adBlueLiters: 12.5,
          }),
        );

        const res = await service.closeCard(
          'card_1',
          { ...dto, adBlue: true, adBlueLiters: 12.5 },
          session,
        );

        expect(res).toMatchObject({ adBlue: true, adBlueLiters: 12.5 });
      });
    });

    describe('photoCapturedAt (EXIF del dispositivo)', () => {
      // Instantes DIURNOS chilenos alineados con la apertura de la tarjeta:
      // el passthrough solo aplica cuando el instante real cae DENTRO del día
      // de turno de la tarjeta (`fuelDateForShiftDay`). Con `iso()` a secas
      // estos tests dependerían de la hora a la que corra Jest.
      const capturadoDeDia = instantAtBusinessHour(12).toISOString();

      beforeEach(() => {
        // Tarjeta DIURNA abierta el mismo día de negocio que los instantes
        // de captura (sin `shift` vinculado: cubre el fallback por reloj).
        prisma.registroHorometro.findUnique.mockResolvedValue({
          id: 'card_1',
          equipoId: 'e1',
          valorInicial: 100,
          valorFinal: null,
          turno: 'DIURNO',
          supervisorId: 'sup_1',
          closeClientId: null,
          closedAt: null,
          fecha: new Date(capturadoDeDia),
          createdAt: new Date(capturadoDeDia),
          shift: null,
        });
      });

      it('un photoCapturedAt válido y dentro de rango se usa como fecha de la carga', async () => {
        const photoCapturedAt = new Date(
          new Date(capturadoDeDia).getTime() - 60_000,
        ).toISOString(); // 1 minuto antes

        await service.closeCard(
          'card_1',
          { ...dto, capturedAt: capturadoDeDia, photoCapturedAt },
          session,
        );

        expect(
          (
            lastCallData(tx.registroCombustible.create).fecha as Date
          ).toISOString(),
        ).toBe(photoCapturedAt);
      });

      it('un photoCapturedAt NO parseable (ej. "2026-W01") NO rechaza el cierre — cae a capturedAt', async () => {
        await expect(
          service.closeCard(
            'card_1',
            { ...dto, capturedAt: capturadoDeDia, photoCapturedAt: '2026-W01' },
            session,
          ),
        ).resolves.toBeDefined();

        expect(
          (
            lastCallData(tx.registroCombustible.create).fecha as Date
          ).toISOString(),
        ).toBe(capturadoDeDia);
      });

      it('un photoCapturedAt fuera de la ventana razonable (EXIF con reloj mal configurado) NO rechaza — cae a capturedAt', async () => {
        const photoCapturedAtAbsurdo = new Date(
          Date.now() - 30 * 24 * 60 * 60 * 1000,
        ).toISOString(); // 30 días de "antigüedad"

        await expect(
          service.closeCard(
            'card_1',
            {
              ...dto,
              capturedAt: capturadoDeDia,
              photoCapturedAt: photoCapturedAtAbsurdo,
            },
            session,
          ),
        ).resolves.toBeDefined();

        expect(
          (
            lastCallData(tx.registroCombustible.create).fecha as Date
          ).toISOString(),
        ).toBe(capturadoDeDia);
      });

      it('sin photoCapturedAt, usa capturedAt (comportamiento previo intacto)', async () => {
        await service.closeCard(
          'card_1',
          { ...dto, capturedAt: capturadoDeDia },
          session,
        );

        expect(
          (
            lastCallData(tx.registroCombustible.create).fecha as Date
          ).toISOString(),
        ).toBe(capturadoDeDia);
      });
    });

    it('replay: mismo closeClientId en una tarjeta YA cerrada → 200 SIN llamar a claimTmp', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValueOnce({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: 130,
        supervisorId: 'sup_1',
        closeClientId: 'close_1',
        closedAt: new Date('2026-09-28T19:00:00.000Z'),
      });
      prisma.registroHorometro.findUnique.mockResolvedValueOnce(
        buildCardRecord({
          id: 'card_1',
          valorFinal: 130,
          closeClientId: 'close_1',
        }),
      );

      const result = await service.closeCard('card_1', dto, session);

      expect(claimTmp).not.toHaveBeenCalled();
      expect(result.id).toBe('card_1');
    });

    it('ALREADY_CLOSED: closeClientId distinto en una tarjeta ya cerrada → 409, sin reclamar', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: 130,
        supervisorId: 'sup_1',
        closeClientId: 'otro_close',
        closedAt: new Date('2026-09-28T19:00:00.000Z'),
      });

      expect.assertions(3);
      try {
        await service.closeCard('card_1', dto, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'ALREADY_CLOSED',
        });
      }
      expect(claimTmp).not.toHaveBeenCalled();
    });

    it('NOT_OWNER: 403 si otro supervisor (no ADMIN) intenta cerrarla', async () => {
      const otherSession = buildSession('otro_sup');

      expect.assertions(2);
      try {
        await service.closeCard('card_1', dto, otherSession);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'NOT_OWNER',
        });
      }
    });

    it('liviano: OTRO supervisor puede cerrarla, y entra en el turno de quien cierra', async () => {
      prisma.equipment.findUnique.mockResolvedValueOnce({
        equipmentClass: 'LIGHT',
      });

      await service.closeCard(
        'card_1',
        { ...dto, shiftDate: todayShiftDate(), shiftType: 'NOCTURNO' },
        buildSession('otro_sup'),
      );

      expect(prisma.shift.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            supervisorId_date_type: expect.objectContaining({
              supervisorId: 'otro_sup',
              type: 'NOCTURNO',
            }) as unknown,
          },
        }),
      );
      const [{ data }] = tx.registroHorometro.updateMany.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).toMatchObject({
        closedById: 'otro_sup',
        closedShiftId: 'shift_1',
      });
    });

    it('liviano: sin el turno de quien cierra, 400', async () => {
      prisma.equipment.findUnique.mockResolvedValueOnce({
        equipmentClass: 'LIGHT',
      });

      await expect(
        service.closeCard('card_1', dto, buildSession('otro_sup')),
      ).rejects.toThrow('Falta el turno de quien cierra');
    });

    it('ADMIN puede cerrar la tarjeta de otro supervisor', async () => {
      const adminSession = buildSession('admin_1', 'ADMIN');

      await expect(
        service.closeCard('card_1', dto, adminSession),
      ).resolves.toBeDefined();
    });

    it('otro supervisor que reintenta (replay) el closeClientId de una tarjeta YA CERRADA ajena → 403 NOT_OWNER, NUNCA la tarjeta de A', async () => {
      // La tarjeta ya está cerrada, es de sup_1, y el closeClientId coincide
      // EXACTO con el del DTO (`dto.closeClientId === 'close_1'`) — el
      // escenario de fuga: B "adivina"/reenvía el closeClientId
      // de A. Sin el chequeo de dueño previo, esto caería en la rama de replay
      // idempotente (que no lo hace) y devolvería la tarjeta completa de A, con la
      // URL firmada de su foto.
      prisma.registroHorometro.findUnique.mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: 130,
        supervisorId: 'sup_1',
        closeClientId: 'close_1',
        closedAt: new Date('2026-09-28T19:00:00.000Z'),
      });
      const otherSession = buildSession('otro_sup');

      expect.assertions(3);
      try {
        await service.closeCard('card_1', dto, otherSession);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'NOT_OWNER',
        });
      }
      // Nunca llegó a reclamar/reusar nada de la foto de A.
      expect(claimTmp).not.toHaveBeenCalled();
    });

    it('ADMIN SÍ puede replayar el closeClientId de una tarjeta ya cerrada de otro supervisor (200)', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: 130,
        supervisorId: 'sup_1',
        closeClientId: 'close_1',
        closedAt: new Date('2026-09-28T19:00:00.000Z'),
        cargasEnCurso: [],
      });
      const adminSession = buildSession('admin_1', 'ADMIN');

      await expect(
        service.closeCard('card_1', dto, adminSession),
      ).resolves.toBeDefined();
    });

    it('HOURMETER_BELOW_INITIAL: rechaza ANTES de reclamar la foto', async () => {
      expect.assertions(3);
      try {
        await service.closeCard('card_1', { ...dto, valorFinal: 50 }, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'HOURMETER_BELOW_INITIAL',
        });
      }
      expect(claimTmp).not.toHaveBeenCalled();
    });

    it('TMP_KEY_EXPIRED: si el claim falla, se propaga tal cual y no hay nada que descartar', async () => {
      claimTmp.mockRejectedValue(
        new BadRequestException({
          message: 'El archivo temporal expiró o no existe, súbelo de nuevo',
          code: 'TMP_KEY_EXPIRED',
        }),
      );

      expect.assertions(4);
      try {
        await service.closeCard('card_1', dto, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'TMP_KEY_EXPIRED',
        });
      }
      expect(discard).not.toHaveBeenCalled();
      expect(tx.registroHorometro.updateMany).not.toHaveBeenCalled();
    });

    it('falla de DB después del claim → descarta la foto reclamada', async () => {
      tx.registroHorometro.updateMany.mockRejectedValue(
        new Error('boom conexión'),
      );

      await expect(service.closeCard('card_1', dto, session)).rejects.toThrow(
        'boom conexión',
      );
      expect(discard).toHaveBeenCalledWith('fuel-photos/final.jpg');
    });

    it('count === 0 (carrera): mismo closeClientId ganó afuera → devuelve la existente y descarta la foto propia', async () => {
      tx.registroHorometro.updateMany.mockResolvedValue({ count: 0 });
      prisma.registroHorometro.findUnique
        .mockResolvedValueOnce({
          id: 'card_1',
          equipoId: 'e1',
          valorInicial: 100,
          valorFinal: null,
          supervisorId: 'sup_1',
          closeClientId: null,
          closedAt: null,
        })
        .mockResolvedValueOnce(
          buildCardRecord({
            id: 'card_1',
            valorFinal: 130,
            closeClientId: 'close_1',
          }),
        );

      const result = await service.closeCard('card_1', dto, session);

      expect(result.id).toBe('card_1');
      expect(discard).toHaveBeenCalledWith('fuel-photos/final.jpg');
    });

    it('count === 0 (carrera): closeClientId distinto afuera → 409 ALREADY_CLOSED', async () => {
      tx.registroHorometro.updateMany.mockResolvedValue({ count: 0 });
      prisma.registroHorometro.findUnique
        .mockResolvedValueOnce({
          id: 'card_1',
          equipoId: 'e1',
          valorInicial: 100,
          valorFinal: null,
          supervisorId: 'sup_1',
          closeClientId: null,
          closedAt: null,
        })
        .mockResolvedValueOnce(
          buildCardRecord({
            id: 'card_1',
            valorFinal: 130,
            closeClientId: 'otro_close',
            closedAt: new Date('2026-09-28T19:00:00.000Z'),
          }),
        );

      await expect(
        service.closeCard('card_1', dto, session),
      ).rejects.toMatchObject({});
      expect(discard).toHaveBeenCalledWith('fuel-photos/final.jpg');
    });

    // Un `closeClientId` reusado en OTRA tarjeta (P2002 vía el `@unique`
    // global, no `count === 0`) caía siempre en `ALREADY_CLOSED` ("la
    // tarjeta ya fue cerrada") — mensaje engañoso cuando la tarjeta `id` en
    // cuestión en realidad SIGUE abierta.
    it('P2002 por closeClientId reusado en OTRA tarjeta que sigue ABIERTA → 409 ID_CONFLICT (no ALREADY_CLOSED)', async () => {
      tx.registroHorometro.updateMany.mockImplementation(() => {
        throw prismaError('P2002', { target: ['close_client_id'] });
      });
      // El `beforeEach` de este describe ya deja `prisma.registroHorometro
      // .findUnique` devolviendo la tarjeta `id` ABIERTA con `closeClientId:
      // null` — exactamente lo que necesita tanto el chequeo inicial COMO la
      // re-lectura de `resolveCloseRace`: el P2002 fue por el `@unique`
      // chocando con OTRA fila, esta tarjeta nunca llegó a escribir nada.

      expect.assertions(3);
      try {
        await service.closeCard('card_1', dto, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'ID_CONFLICT',
        });
      }
      expect(discard).toHaveBeenCalledWith('fuel-photos/final.jpg');
    });
  });

  describe('addFuelLoad (carga de liviano sin cerrar la tarjeta)', () => {
    const session = buildSession('sup_2');
    const LOAD_ID = '33333333-3333-4333-8333-333333333333';
    const dto: CreateShiftCardFuelLoadDto = {
      id: LOAD_ID,
      liters: 45,
      reading: 1250,
      tmpPhotoKey: 'tmp/sup_2/11111111-1111-4111-8111-111111111111.jpg',
      capturedAt: iso(),
    };
    const EQUIPO_LIVIANO = {
      equipmentClass: 'LIGHT',
      controlUnit: 'KM',
      currentHourmeter: null,
      currentMileage: 1200,
    };
    const CARGA = {
      id: LOAD_ID,
      litros: 45,
      lectura: 1250,
      adBlueLitros: null,
      fotoKey: 'fuel-photos/carga.jpg',
      fecha: new Date('2026-09-28T15:00:00.000Z'),
      createdAt: new Date('2026-09-28T15:00:00.000Z'),
      createdById: 'sup_2',
    };

    function cardAbierta(overrides: Record<string, unknown> = {}) {
      return {
        equipoId: 'e1',
        valorInicial: 1200,
        valorFinal: null,
        closedAt: null,
        equipo: EQUIPO_LIVIANO,
        ...overrides,
      };
    }

    beforeEach(() => {
      // Sin carga previa con ese id: no es un reintento.
      prisma.registroCombustible.findUnique.mockResolvedValue(null);
      // 1ª lectura: la tarjeta a validar; 2ª: la recarga para la respuesta.
      prisma.registroHorometro.findUnique
        .mockResolvedValueOnce(cardAbierta())
        .mockResolvedValueOnce(
          buildCardRecord({
            valorInicial: 1200,
            equipo: { ...EQUIPO_INCLUDE, equipmentClass: 'LIGHT' },
            cargasEnCurso: [CARGA],
          }),
        );
      tx.$queryRaw.mockResolvedValue([{ id: 'card_1' }]);
      tx.registroHorometro.findUnique.mockResolvedValue({
        valorFinal: null,
        closedAt: null,
      });
      tx.registroCombustible.create.mockResolvedValue({ id: LOAD_ID });
      claimTmp.mockResolvedValue('fuel-photos/carga.jpg');
      prisma.user.findMany.mockResolvedValue([
        { id: 'sup_2', name: 'Carla Soto' },
      ]);
    });

    it('registra la carga en la tarjeta abierta sin cerrarla y adelanta el km del equipo', async () => {
      const card = await service.addFuelLoad('card_1', dto, session);

      expect(claimTmp).toHaveBeenCalledWith(
        dto.tmpPhotoKey,
        'sup_2',
        'fuel-photo',
      );
      const data = lastCallData(tx.registroCombustible.create);
      expect(data).toMatchObject({
        id: LOAD_ID,
        createdById: 'sup_2',
        equipoId: 'e1',
        litros: 45,
        tipo: 'PETROLEO',
        fotoKey: 'fuel-photos/carga.jpg',
        lectura: 1250,
        adBlueLitros: null,
        tarjetaEnCursoId: 'card_1',
      });
      // Nunca la 1:1 del cierre.
      expect(data.registroHorometroId).toBeUndefined();
      // La tarjeta NO se cierra.
      expect(tx.registroHorometro.updateMany).not.toHaveBeenCalled();
      expect(tx.registroHorometro.update).not.toHaveBeenCalled();
      // Contador: modo warn, sube el kilometraje.
      expect(tx.equipment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { currentMileage: 1250 } }),
      );
      expect(card.valorFinal).toBeNull();
      expect(card.fuelLoads).toEqual([
        {
          id: LOAD_ID,
          liters: 45,
          reading: 1250,
          adBlueLiters: null,
          pumpPhotoUrl: 'https://signed/fuel-photos/carga.jpg',
          fecha: CARGA.fecha,
          createdAt: CARGA.createdAt,
          createdByName: 'Carla Soto',
        },
      ]);
    });

    it('con el turno de quien carga, la carga se fecha en el día de ese turno', async () => {
      const ayer = todayShiftDate(-2);
      await service.addFuelLoad(
        'card_1',
        { ...dto, shiftDate: ayer, shiftType: 'DIURNO' },
        session,
      );

      const { fecha } = lastCallData(tx.registroCombustible.create);
      expect(businessDayKey(fecha as Date)).toBe(ayer);
    });

    it('con AdBlue, lo guarda en la carga y descuenta Inventario en la misma transacción', async () => {
      await service.addFuelLoad(
        'card_1',
        { ...dto, adBlueLiters: 10 },
        session,
      );

      expect(lastCallData(tx.registroCombustible.create).adBlueLitros).toBe(10);
      expect(adBlueStock.discountLoad).toHaveBeenCalledWith(
        expect.objectContaining({ tx }),
        expect.objectContaining({
          liters: 10,
          equipmentId: 'e1',
          reference: LOAD_ID,
        }),
      );
      expect(adBlueStock.emitPending).toHaveBeenCalled();
    });

    it('rechaza la tarjeta de un pesado con FUEL_LOAD_LIGHT_ONLY, sin reclamar la foto', async () => {
      prisma.registroHorometro.findUnique.mockReset().mockResolvedValueOnce(
        cardAbierta({
          equipo: { ...EQUIPO_LIVIANO, equipmentClass: 'HEAVY' },
        }),
      );

      expect.assertions(3);
      try {
        await service.addFuelLoad('card_1', dto, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'FUEL_LOAD_LIGHT_ONLY',
        });
      }
      expect(claimTmp).not.toHaveBeenCalled();
    });

    it('rechaza una tarjeta ya cerrada con ALREADY_CLOSED', async () => {
      prisma.registroHorometro.findUnique
        .mockReset()
        .mockResolvedValueOnce(
          cardAbierta({ valorFinal: 1300, closedAt: new Date() }),
        );

      expect.assertions(3);
      try {
        await service.addFuelLoad('card_1', dto, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'ALREADY_CLOSED',
        });
      }
      expect(claimTmp).not.toHaveBeenCalled();
    });

    it('si un cierre gana la carrera (cerrada al bloquearla), rechaza y descarta la foto', async () => {
      tx.registroHorometro.findUnique.mockResolvedValue({
        valorFinal: 1300,
        closedAt: new Date(),
      });
      // `createOrReturn` relee tras el error: la carga nunca se creó.
      prisma.registroCombustible.findUnique.mockResolvedValue(null);

      await expect(
        service.addFuelLoad('card_1', dto, session),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.registroCombustible.create).not.toHaveBeenCalled();
      expect(discard).toHaveBeenCalledWith('fuel-photos/carga.jpg');
    });

    it('rechaza una lectura menor que la inicial de la tarjeta con HOURMETER_BELOW_INITIAL', async () => {
      expect.assertions(3);
      try {
        await service.addFuelLoad('card_1', { ...dto, reading: 1199 }, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'HOURMETER_BELOW_INITIAL',
        });
      }
      expect(claimTmp).not.toHaveBeenCalled();
    });

    it('404 CARD_NOT_FOUND si la tarjeta no existe', async () => {
      prisma.registroHorometro.findUnique.mockReset().mockResolvedValue(null);

      await expect(
        service.addFuelLoad('card_x', dto, session),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reintento del mismo usuario: devuelve la tarjeta SIN reclamar la foto ni crear otra carga', async () => {
      prisma.registroCombustible.findUnique.mockResolvedValue({
        createdById: 'sup_2',
        tarjetaEnCursoId: 'card_1',
      });
      prisma.registroHorometro.findUnique.mockReset().mockResolvedValueOnce(
        buildCardRecord({
          equipo: { ...EQUIPO_INCLUDE, equipmentClass: 'LIGHT' },
          cargasEnCurso: [CARGA],
        }),
      );

      const card = await service.addFuelLoad('card_1', dto, session);

      expect(card.fuelLoads).toHaveLength(1);
      expect(claimTmp).not.toHaveBeenCalled();
      expect(tx.registroCombustible.create).not.toHaveBeenCalled();
      expect(tx.equipment.updateMany).not.toHaveBeenCalled();
    });

    it('id de carga de OTRO usuario → 409 ID_CONFLICT', async () => {
      prisma.registroCombustible.findUnique.mockResolvedValue({
        createdById: 'otro',
        tarjetaEnCursoId: 'card_1',
      });

      expect.assertions(3);
      try {
        await service.addFuelLoad('card_1', dto, session);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'ID_CONFLICT',
        });
      }
      expect(claimTmp).not.toHaveBeenCalled();
    });

    it('id ya usado por una carga de OTRA tarjeta (aunque sea propia) → 409 ID_CONFLICT', async () => {
      prisma.registroCombustible.findUnique.mockResolvedValue({
        createdById: 'sup_2',
        tarjetaEnCursoId: 'card_otra',
      });

      await expect(
        service.addFuelLoad('card_1', dto, session),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cierre posterior con 0 L y sin motivo: se cierra igual y la respuesta no trae motivo', async () => {
      prisma.registroHorometro.findUnique.mockReset().mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 1200,
        valorFinal: null,
        supervisorId: 'sup_1',
        closeClientId: null,
        closedAt: null,
        shift: null,
        fecha: new Date(),
        turno: 'DIURNO',
      });
      prisma.equipment.findUnique.mockResolvedValueOnce({
        equipmentClass: 'LIGHT',
      });
      tx.equipment.findUnique.mockResolvedValue({
        controlUnit: 'KM',
        currentHourmeter: null,
        currentMileage: 1250,
      });
      tx.registroHorometro.findUnique.mockResolvedValue(
        buildCardRecord({
          valorInicial: 1200,
          valorFinal: 1300,
          fuelLiters: 0,
          noFuelReason: null,
          equipo: { ...EQUIPO_INCLUDE, equipmentClass: 'LIGHT' },
          cargasEnCurso: [CARGA],
        }),
      );

      tx.registroCombustible.count.mockResolvedValue(1);

      const card = await service.closeCard(
        'card_1',
        {
          closeClientId: 'close_9',
          valorFinal: 1300,
          fuelLiters: 0,
          capturedAt: iso(),
          shiftDate: todayShiftDate(),
          shiftType: 'DIURNO',
        },
        session,
      );

      expect(claimTmp).not.toHaveBeenCalled();
      expect(tx.registroCombustible.create).not.toHaveBeenCalled();
      expect(card.noFuelReason).toBeNull();
      expect(card.fuelLoads).toHaveLength(1);
    });
  });

  describe('lecturas vs. cargas registradas con la tarjeta abierta', () => {
    const session = buildSession('sup_1');

    it('cierre: km final menor que una carga en curso → 400 READING_BELOW_FUEL_LOAD y descarta la foto', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 1200,
        valorFinal: null,
        supervisorId: 'sup_1',
        closeClientId: null,
        closedAt: null,
        shift: null,
        fecha: new Date(),
        turno: 'DIURNO',
      });
      prisma.equipment.findUnique.mockResolvedValueOnce({
        equipmentClass: 'LIGHT',
      });
      claimTmp.mockResolvedValue('fuel-photos/final.jpg');
      tx.registroCombustible.aggregate.mockResolvedValue({
        _max: { lectura: 1300 },
      });

      await expect(
        service.closeCard(
          'card_1',
          {
            closeClientId: 'close_1',
            valorFinal: 1290,
            fuelLiters: 20,
            tmpPhotoKey: 'tmp/sup_1/11111111-1111-4111-8111-111111111111.jpg',
            capturedAt: iso(),
            shiftDate: todayShiftDate(),
            shiftType: 'DIURNO',
          },
          session,
        ),
      ).rejects.toMatchObject({
        response: { code: 'READING_BELOW_FUEL_LOAD' },
      });
      expect(tx.registroCombustible.aggregate).toHaveBeenCalledWith({
        where: { tarjetaEnCursoId: 'card_1' },
        _max: { lectura: true },
      });
      expect(tx.registroCombustible.create).not.toHaveBeenCalled();
      expect(discard).toHaveBeenCalledWith('fuel-photos/final.jpg');
    });

    it('cierre: km final igual a la última carga en curso pasa', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 1200,
        valorFinal: null,
        supervisorId: 'sup_1',
        closeClientId: null,
        closedAt: null,
        shift: null,
        fecha: new Date(),
        turno: 'DIURNO',
      });
      prisma.equipment.findUnique.mockResolvedValueOnce({
        equipmentClass: 'LIGHT',
      });
      tx.equipment.findUnique.mockResolvedValue(null);
      tx.registroCombustible.aggregate.mockResolvedValue({
        _max: { lectura: 1300 },
      });
      tx.registroHorometro.findUnique.mockResolvedValue(
        buildCardRecord({ valorInicial: 1200, valorFinal: 1300 }),
      );

      await expect(
        service.closeCard(
          'card_1',
          {
            closeClientId: 'close_1',
            valorFinal: 1300,
            fuelLiters: 0,
            capturedAt: iso(),
            shiftDate: todayShiftDate(),
            shiftType: 'DIURNO',
          },
          session,
        ),
      ).resolves.toBeDefined();
    });

    it('cierre admin: km final menor que una carga en curso → 400 READING_BELOW_FUEL_LOAD', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue({
        equipoId: 'e1',
        valorInicial: 1200,
        valorFinal: null,
        closedAt: null,
        observaciones: null,
        belowPreviousReading: false,
      });
      tx.registroCombustible.aggregate.mockResolvedValue({
        _max: { lectura: 1300 },
      });

      await expect(
        service.adminCloseCard(
          'card_1',
          { valorFinal: 1250 },
          buildSession('adm_1', 'ADMIN', 'Admin'),
        ),
      ).rejects.toMatchObject({
        response: { code: 'READING_BELOW_FUEL_LOAD' },
      });
    });
  });

  describe('cierre del liviano que ya cargó con la tarjeta abierta', () => {
    const session = buildSession('sup_1');

    function cierre(overrides: Partial<CloseShiftCardDto> = {}) {
      return {
        closeClientId: 'close_1',
        valorFinal: 1300,
        capturedAt: iso(),
        shiftDate: todayShiftDate(),
        shiftType: 'DIURNO' as const,
        ...overrides,
      } as CloseShiftCardDto;
    }

    beforeEach(() => {
      prisma.registroHorometro.findUnique.mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 1200,
        valorFinal: null,
        supervisorId: 'sup_1',
        closeClientId: null,
        closedAt: null,
        shift: null,
        fecha: new Date(),
        turno: 'DIURNO',
      });
      prisma.equipment.findUnique.mockResolvedValueOnce({
        equipmentClass: 'LIGHT',
      });
      tx.equipment.findUnique.mockResolvedValue(null);
      tx.registroHorometro.findUnique.mockResolvedValue(
        buildCardRecord({
          valorInicial: 1200,
          valorFinal: 1300,
          cargasEnCurso: [CARGA_EN_CURSO],
        }),
      );
      tx.registroCombustible.count.mockResolvedValue(1);
    });

    it('con cargas en curso cierra solo con km final: sin litros, sin foto, sin AdBlue', async () => {
      await service.closeCard(
        'card_1',
        cierre({ observaciones: 'Devuelta en bodega' }),
        session,
      );

      expect(claimTmp).not.toHaveBeenCalled();
      expect(tx.registroCombustible.create).not.toHaveBeenCalled();
      expect(adBlueStock.discountLoad).not.toHaveBeenCalled();
      expect(lastCallData(tx.registroHorometro.updateMany)).toMatchObject({
        valorFinal: 1300,
        fuelLiters: 0,
        pumpPhotoKey: null,
        adBlue: false,
        adBlueLiters: null,
        observaciones: 'Devuelta en bodega',
        noFuelReason: null,
      });
    });

    it('con cargas en curso, un motivo sin carga que llegue igual no se guarda', async () => {
      await service.closeCard(
        'card_1',
        cierre({ fuelLiters: 0, noFuelReason: 'Corte de luz' }),
        session,
      );

      expect(tx.registroHorometro.update).toHaveBeenCalledWith({
        where: { id: 'card_1' },
        data: { noFuelReason: null },
      });
    });

    it('con cargas en curso, si igual informa litros (> 0) se registra la carga del cierre como hoy', async () => {
      claimTmp.mockResolvedValue('fuel-photos/final.jpg');

      await service.closeCard(
        'card_1',
        cierre({
          fuelLiters: 20,
          tmpPhotoKey: 'tmp/sup_1/11111111-1111-4111-8111-111111111111.jpg',
        }),
        session,
      );

      expect(lastCallData(tx.registroCombustible.create)).toMatchObject({
        litros: 20,
        fotoKey: 'fuel-photos/final.jpg',
        registroHorometroId: 'card_1',
      });
    });

    it('con litros > 0 la foto sigue siendo obligatoria (FUEL_PHOTO_REQUIRED)', async () => {
      await expect(
        service.closeCard('card_1', cierre({ fuelLiters: 20 }), session),
      ).rejects.toMatchObject({ response: { code: 'FUEL_PHOTO_REQUIRED' } });
    });

    it('SIN cargas en curso, omitir los litros es 400 FUEL_LITERS_REQUIRED (regla de siempre)', async () => {
      tx.registroCombustible.count.mockResolvedValue(0);

      await expect(
        service.closeCard('card_1', cierre(), session),
      ).rejects.toMatchObject({ response: { code: 'FUEL_LITERS_REQUIRED' } });
      expect(tx.registroCombustible.count).toHaveBeenCalledWith({
        where: { tarjetaEnCursoId: 'card_1' },
      });
    });

    it('un pesado (nunca tiene cargas en curso) sin litros → 400 FUEL_LITERS_REQUIRED', async () => {
      prisma.equipment.findUnique.mockReset().mockResolvedValue({
        equipmentClass: 'HEAVY',
      });
      tx.registroCombustible.count.mockResolvedValue(0);

      await expect(
        service.closeCard(
          'card_1',
          cierre({ shiftDate: undefined, shiftType: undefined }),
          session,
        ),
      ).rejects.toMatchObject({ response: { code: 'FUEL_LITERS_REQUIRED' } });
    });
  });

  describe('aviso fuel.loaded (carga de combustible de una camioneta)', () => {
    const session = buildSession('sup_1', 'SUPERVISOR', 'Jorge SMI');

    function avisos(): Array<Record<string, unknown>> {
      return (
        eventEmitter.emit.mock.calls as Array<[string, Record<string, unknown>]>
      )
        .filter(([name]) => name === 'fuel.loaded')
        .map(([, payload]) => payload);
    }

    describe('carga con la tarjeta abierta', () => {
      const LOAD_ID = '44444444-4444-4444-8444-444444444444';
      const dto: CreateShiftCardFuelLoadDto = {
        id: LOAD_ID,
        liters: 42.5,
        reading: 22037,
        tmpPhotoKey: 'tmp/sup_1/11111111-1111-4111-8111-111111111111.jpg',
        capturedAt: iso(),
      };

      beforeEach(() => {
        prisma.registroCombustible.findUnique.mockResolvedValue(null);
        prisma.registroHorometro.findUnique
          .mockResolvedValueOnce({
            equipoId: 'e9',
            valorInicial: 22000,
            valorFinal: null,
            closedAt: null,
            equipo: {
              internalCode: 'MB-008',
              equipmentClass: 'LIGHT',
              controlUnit: 'KM',
              currentHourmeter: null,
              currentMileage: 22000,
            },
          })
          .mockResolvedValueOnce(buildCardRecord());
        tx.$queryRaw.mockResolvedValue([{ id: 'card_1' }]);
        tx.registroHorometro.findUnique.mockResolvedValue({
          valorFinal: null,
          closedAt: null,
        });
        claimTmp.mockResolvedValue('fuel-photos/carga.jpg');
      });

      it('emite fuel.loaded con la carga, el equipo, los km y quién la registró', async () => {
        await service.addFuelLoad('card_1', dto, session);

        expect(avisos()).toEqual([
          {
            cargaId: LOAD_ID,
            cardId: 'card_1',
            equipmentId: 'e9',
            equipmentCode: 'MB-008',
            liters: 42.5,
            reading: 22037,
            unit: 'km',
            origin: 'TARJETA_ABIERTA',
            actorId: 'sup_1',
            actorName: 'Jorge SMI',
            actorRole: 'SUPERVISOR',
          },
        ]);
      });

      it('no avisa en el reintento idempotente (no se creó nada)', async () => {
        prisma.registroCombustible.findUnique.mockResolvedValue({
          createdById: 'sup_1',
          tarjetaEnCursoId: 'card_1',
        });
        prisma.registroHorometro.findUnique
          .mockReset()
          .mockResolvedValue(buildCardRecord());

        await service.addFuelLoad('card_1', dto, session);

        expect(avisos()).toEqual([]);
      });

      it('no avisa si la carga falla (tarjeta cerrada al bloquearla)', async () => {
        tx.registroHorometro.findUnique.mockResolvedValue({
          valorFinal: 22100,
          closedAt: new Date(),
        });

        await expect(
          service.addFuelLoad('card_1', dto, session),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(avisos()).toEqual([]);
      });
    });

    describe('cierre', () => {
      function cardAbierta() {
        return {
          id: 'card_1',
          equipoId: 'e9',
          valorInicial: 22000,
          valorFinal: null,
          supervisorId: 'sup_1',
          closeClientId: null,
          closedAt: null,
          shift: null,
          fecha: new Date(),
          turno: 'DIURNO',
        };
      }
      const conLitros = {
        closeClientId: 'close_1',
        valorFinal: 22100,
        fuelLiters: 30,
        tmpPhotoKey: 'tmp/sup_1/11111111-1111-4111-8111-111111111111.jpg',
        capturedAt: iso(),
        shiftDate: todayShiftDate(),
        shiftType: 'DIURNO' as const,
      };

      beforeEach(() => {
        prisma.registroHorometro.findUnique.mockResolvedValue(cardAbierta());
        claimTmp.mockResolvedValue('fuel-photos/final.jpg');
        tx.equipment.findUnique.mockResolvedValue(null);
        tx.registroCombustible.create.mockResolvedValue({ id: 'carga_c' });
        tx.registroHorometro.findUnique.mockResolvedValue(
          buildCardRecord({
            equipoId: 'e9',
            valorInicial: 22000,
            valorFinal: 22100,
            equipo: {
              internalCode: 'MB-008',
              type: 'Camioneta',
              controlUnit: 'KM',
              equipmentClass: 'LIGHT',
            },
          }),
        );
      });

      it('liviano con litros: avisa la carga del cierre', async () => {
        prisma.equipment.findUnique.mockResolvedValueOnce({
          equipmentClass: 'LIGHT',
        });

        await service.closeCard('card_1', conLitros, session);

        expect(avisos()).toEqual([
          expect.objectContaining({
            cargaId: 'carga_c',
            cardId: 'card_1',
            equipmentCode: 'MB-008',
            liters: 30,
            reading: 22100,
            unit: 'km',
            origin: 'CIERRE',
            actorId: 'sup_1',
          }),
        ]);
      });

      it('pesado con litros: NO avisa', async () => {
        prisma.equipment.findUnique.mockResolvedValueOnce({
          equipmentClass: 'HEAVY',
        });

        await service.closeCard(
          'card_1',
          { ...conLitros, shiftDate: undefined, shiftType: undefined },
          session,
        );

        expect(tx.registroCombustible.create).toHaveBeenCalled();
        expect(avisos()).toEqual([]);
      });

      it('liviano que cierra solo con km (ya cargó con la tarjeta abierta): NO avisa', async () => {
        prisma.equipment.findUnique.mockResolvedValueOnce({
          equipmentClass: 'LIGHT',
        });
        tx.registroCombustible.count.mockResolvedValue(1);

        await service.closeCard(
          'card_1',
          {
            ...conLitros,
            fuelLiters: undefined,
            tmpPhotoKey: undefined,
          },
          session,
        );

        expect(tx.registroCombustible.create).not.toHaveBeenCalled();
        expect(avisos()).toEqual([]);
      });

      it('replay del cierre ya aplicado: NO avisa', async () => {
        prisma.equipment.findUnique.mockResolvedValueOnce({
          equipmentClass: 'LIGHT',
        });
        prisma.registroHorometro.findUnique.mockResolvedValue({
          ...cardAbierta(),
          valorFinal: 22100,
          closeClientId: 'close_1',
          closedAt: new Date(),
          cargasEnCurso: [],
        });

        await service.closeCard('card_1', conLitros, session);

        expect(avisos()).toEqual([]);
      });
    });

    describe('registro de un turno pasado (POST /shift-cards/closed)', () => {
      const pasado = {
        id: '55555555-5555-4555-8555-555555555555',
        equipoId: 'e9',
        valorInicial: 22000,
        valorFinal: 22100,
        shiftDate: todayShiftDate(-3),
        shiftType: 'DIURNO' as const,
        capturedAt: iso(),
        closeClientId: '66666666-6666-4666-8666-666666666666',
        fuelLiters: 30,
        tmpPhotoKey: 'tmp/sup_1/11111111-1111-4111-8111-111111111111.jpg',
      };
      const EQUIPO_LIVIANO = {
        internalCode: 'MB-008',
        type: 'Camioneta',
        controlUnit: 'KM',
        equipmentClass: 'LIGHT',
      };

      beforeEach(() => {
        prisma.equipment.findUnique.mockResolvedValue({
          equipmentClass: 'LIGHT',
        });
        prisma.registroHorometro.findUnique.mockResolvedValue(null);
        claimTmp.mockResolvedValue('fuel-photos/pasado.jpg');
        tx.equipment.findUnique.mockResolvedValue({
          equipmentClass: 'LIGHT',
          controlUnit: 'KM',
          currentHourmeter: null,
          currentMileage: 22000,
        });
        tx.registroHorometro.create.mockImplementation(
          ({ data }: { data: Record<string, unknown> }) =>
            buildCardRecord({ ...data, equipo: EQUIPO_LIVIANO }),
        );
        tx.registroCombustible.create.mockResolvedValue({ id: 'carga_p' });
        // El liviano queda en el turno de quien lo registra (`closedShiftId`).
        prisma.shift.findMany.mockResolvedValue([]);
      });

      it('liviano con litros: avisa la carga (origin CIERRE)', async () => {
        await service.registerClosedCard(pasado, session);

        expect(avisos()).toEqual([
          expect.objectContaining({
            cargaId: 'carga_p',
            cardId: pasado.id,
            equipmentId: 'e9',
            equipmentCode: 'MB-008',
            liters: 30,
            reading: 22100,
            unit: 'km',
            origin: 'CIERRE',
            actorId: 'sup_1',
            actorRole: 'SUPERVISOR',
          }),
        ]);
      });

      it('liviano sin litros: no hay carga, no avisa', async () => {
        await service.registerClosedCard({ ...pasado, fuelLiters: 0 }, session);

        expect(tx.registroCombustible.create).not.toHaveBeenCalled();
        expect(avisos()).toEqual([]);
      });

      it('pesado con litros: NO avisa', async () => {
        prisma.equipment.findUnique.mockResolvedValue({
          equipmentClass: 'HEAVY',
        });
        tx.equipment.findUnique.mockResolvedValue({
          equipmentClass: 'HEAVY',
          controlUnit: 'HOURS',
          currentHourmeter: 100,
          currentMileage: null,
        });
        tx.registroHorometro.create.mockImplementation(
          ({ data }: { data: Record<string, unknown> }) =>
            buildCardRecord({ ...data }),
        );

        await service.registerClosedCard(
          { ...pasado, operatorId: 'op_1', valorInicial: 100, valorFinal: 108 },
          session,
        );

        expect(tx.registroCombustible.create).toHaveBeenCalled();
        expect(avisos()).toEqual([]);
      });

      it('replay por dto.id: devuelve la existente y NO avisa', async () => {
        prisma.registroHorometro.findUnique.mockResolvedValue(
          buildCardRecord({
            id: pasado.id,
            equipoId: 'e9',
            supervisorId: 'sup_1',
            equipo: EQUIPO_LIVIANO,
          }),
        );

        await service.registerClosedCard(pasado, session);

        expect(claimTmp).not.toHaveBeenCalled();
        expect(avisos()).toEqual([]);
      });
    });

    describe('rol de quien registra, para el texto', () => {
      it('toma el primer rol reconocible de una lista o de «A,B»', () => {
        expect(primerRolConocido('SUPERVISOR,ADMIN')).toBe('SUPERVISOR');
        expect(primerRolConocido(' OTRO , ADMIN')).toBe('ADMIN');
        expect(primerRolConocido(['X', 'PREVENCIONISTA'])).toBe(
          'PREVENCIONISTA',
        );
        expect(primerRolConocido('ADMIN')).toBe('ADMIN');
      });

      it('null si no hay rol o ninguno es conocido', () => {
        expect(primerRolConocido(undefined)).toBeNull();
        expect(primerRolConocido('')).toBeNull();
        expect(primerRolConocido('OTRO')).toBeNull();
      });
    });
  });

  describe('update (PATCH)', () => {
    const owner = buildSession('sup_1', 'SUPERVISOR', 'Ana Soto');

    function closedCard(overrides: Record<string, unknown> = {}) {
      return buildCardRecord({
        id: 'card_1',
        valorInicial: 100,
        valorFinal: 130,
        fuelLiters: 0,
        pumpPhotoKey: 'fuel-photos/final.jpg',
        closeClientId: 'close_1',
        closedAt: new Date('2026-09-28T20:00:00.000Z'),
        fechaSalida: new Date('2026-09-28T19:55:00.000Z'),
        adBlue: false,
        adBlueLiters: null,
        ...overrides,
      });
    }

    function givenCard(card: ReturnType<typeof closedCard>) {
      const shift = card.shift as { type: string; date: Date } | null;
      prisma.registroHorometro.findUnique.mockResolvedValue({
        supervisorId: card.supervisorId,
        operatorId: card.operatorId,
        valorFinal: card.valorFinal,
        // `findOwnedCard` trae el turno: la clave del `Shift` de destino
        // cuando la edición corrige `turno`.
        shift: shift
          ? {
              type: shift.type,
              date: shift.date,
              supervisorId: card.supervisorId,
            }
          : null,
      });
      tx.registroHorometro.findUnique.mockResolvedValue(card);
    }

    beforeEach(() => {
      givenCard(closedCard());
      tx.$queryRaw.mockResolvedValue([{ id: 'card_1' }]);
      tx.registroHorometro.update.mockResolvedValue({});
      tx.registroCombustible.findUnique.mockResolvedValue(null);
      tx.registroCombustible.create.mockResolvedValue({});
      tx.registroCombustible.update.mockResolvedValue({});
      tx.registroCombustible.delete.mockResolvedValue({});
      tx.equipment.findUnique.mockResolvedValue({
        controlUnit: 'HOURS',
        currentHourmeter: 130,
        currentMileage: null,
      });
      changeLog.record.mockResolvedValue({});
    });

    async function errorOf(promise: Promise<unknown>): Promise<unknown> {
      try {
        await promise;
      } catch (error: unknown) {
        return (error as { getResponse: () => unknown }).getResponse();
      }
      throw new Error('se esperaba un error');
    }

    describe('AdBlue en la edición: el descuento sigue a la corrección por la diferencia', () => {
      it('agregar AdBlue descuenta los litros nuevos', async () => {
        await service.update(
          'card_1',
          { adBlue: true, adBlueLiters: 10 },
          owner,
        );

        expect(adBlueStock.discountLoad).toHaveBeenCalledWith(
          { tx, events: [] },
          expect.objectContaining({ liters: 10, reference: 'card_1' }),
        );
        expect(adBlueStock.restoreLoad).not.toHaveBeenCalled();
      });

      it('bajar los litros devuelve la diferencia al saldo', async () => {
        givenCard(closedCard({ adBlue: true, adBlueLiters: 10 }));

        await service.update('card_1', { adBlueLiters: 4 }, owner);

        expect(adBlueStock.restoreLoad).toHaveBeenCalledWith(
          { tx, events: [] },
          expect.objectContaining({ liters: 6, reference: 'card_1' }),
        );
        expect(adBlueStock.discountLoad).not.toHaveBeenCalled();
      });

      it('quitar el AdBlue devuelve todos los litros', async () => {
        givenCard(closedCard({ adBlue: true, adBlueLiters: 10 }));

        await service.update('card_1', { adBlue: false }, owner);

        expect(adBlueStock.restoreLoad).toHaveBeenCalledWith(
          { tx, events: [] },
          expect.objectContaining({ liters: 10 }),
        );
      });

      it('una edición que no toca el AdBlue no mueve el inventario', async () => {
        givenCard(closedCard({ adBlue: true, adBlueLiters: 10 }));

        await service.update('card_1', { observaciones: 'ok' }, owner);

        expect(adBlueStock.discountLoad).not.toHaveBeenCalled();
        expect(adBlueStock.restoreLoad).not.toHaveBeenCalled();
      });
    });

    describe('precondiciones', () => {
      it('un body vacío es 400', async () => {
        await expect(
          service.update('card_1', {}, owner),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('404 CARD_NOT_FOUND si no existe', async () => {
        prisma.registroHorometro.findUnique.mockResolvedValue(null);

        expect(
          await errorOf(service.update('x', { observaciones: 'a' }, owner)),
        ).toMatchObject({ code: 'CARD_NOT_FOUND' });
      });

      it('403 NOT_OWNER para otro supervisor', async () => {
        const other = buildSession('sup_2');

        expect(
          await errorOf(
            service.update('card_1', { observaciones: 'a' }, other),
          ),
        ).toMatchObject({ code: 'NOT_OWNER' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('la SECRETARIA corrige la tarjeta de un supervisor temporal', async () => {
        const secre = buildSession('sec_1', 'SECRETARIA', 'Sec Uno');
        givenCard(closedCard({ temporal: true, shift: null, shiftId: null }));
        prisma.registroHorometro.findUnique.mockResolvedValue({
          supervisorId: 'sup_1',
          operatorId: 'op_1',
          valorFinal: 130,
          temporal: true,
          shift: null,
        });

        await service.update('card_1', { valorFinal: 140 }, secre);

        expect(changeLog.record).toHaveBeenCalledTimes(1);
      });

      it('la SECRETARIA recibe 403 NOT_OWNER en una tarjeta normal', async () => {
        const secre = buildSession('sec_1', 'SECRETARIA', 'Sec Uno');

        expect(
          await errorOf(service.update('card_1', { valorFinal: 140 }, secre)),
        ).toMatchObject({ code: 'NOT_OWNER' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('un ADMIN puede editar la tarjeta de otro', async () => {
        const admin = buildSession('adm_1', 'ADMIN', 'Admin');

        await service.update('card_1', { observaciones: 'a' }, admin);

        expect(changeLog.record).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['valorFinal', { valorFinal: 140 }],
        ['fuelLiters', { fuelLiters: 10 }],
        ['adBlue', { adBlue: true, adBlueLiters: 5 }],
        ['adBlueLiters', { adBlueLiters: 5 }],
      ])(
        '409 CARD_NOT_CLOSED si la tarjeta sigue abierta y se toca %s',
        async (_name, body) => {
          givenCard(closedCard({ valorFinal: null }));

          expect(
            await errorOf(service.update('card_1', body, owner)),
          ).toMatchObject({ code: 'CARD_NOT_CLOSED' });
          expect(prisma.$transaction).not.toHaveBeenCalled();
        },
      );

      it('en una tarjeta abierta sí se editan observaciones, operador y lectura inicial', async () => {
        givenCard(closedCard({ valorFinal: null }));

        await service.update(
          'card_1',
          { observaciones: 'Cambio de turno', valorInicial: 105 },
          owner,
        );

        expect(lastCallData(tx.registroHorometro.update)).toMatchObject({
          observaciones: 'Cambio de turno',
          valorInicial: 105,
        });
      });
    });

    describe('horómetro', () => {
      it('HOURMETER_BELOW_INITIAL si la final queda bajo la inicial', async () => {
        expect(
          await errorOf(service.update('card_1', { valorFinal: 90 }, owner)),
        ).toMatchObject({ code: 'HOURMETER_BELOW_INITIAL' });
      });

      it('también si es la inicial la que sube por encima de la final guardada', async () => {
        expect(
          await errorOf(service.update('card_1', { valorInicial: 140 }, owner)),
        ).toMatchObject({ code: 'HOURMETER_BELOW_INITIAL' });
      });

      it('al subir la final reconcilia el contador del equipo', async () => {
        await service.update('card_1', { valorFinal: 140 }, owner);

        expect(tx.equipment.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { currentHourmeter: 140 } }),
        );
      });

      it('si la final queda bajo el contador no falla ni lo baja: solo marca la auditoría', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          controlUnit: 'HOURS',
          currentHourmeter: 500,
          currentMileage: null,
        });

        await service.update('card_1', { valorFinal: 120 }, owner);

        expect(tx.equipment.updateMany).not.toHaveBeenCalled();
        expect(lastCallData(tx.registroHorometro.update)).toMatchObject({
          valorFinal: 120,
          belowPreviousReading: true,
        });
      });

      it('no toca el contador si la lectura final no cambia', async () => {
        await service.update('card_1', { observaciones: 'a' }, owner);

        expect(tx.equipment.updateMany).not.toHaveBeenCalled();
      });

      it('corregir un typo que había inflado el contador lo devuelve a la lectura real (caso SEM05)', async () => {
        givenCard(closedCard({ valorInicial: 2600, valorFinal: 4606 }));
        // El typo había llevado el contador del equipo a 4.606 h.
        tx.equipment.findUnique.mockResolvedValue({
          controlUnit: 'HOURS',
          currentHourmeter: 4606,
          currentMileage: null,
        });
        // Ya corregida, la lectura más alta que queda es la de esta tarjeta.
        tx.registroHorometro.aggregate.mockResolvedValue({
          _max: { valorInicial: 2600, valorFinal: 2606 },
        });

        await service.update('card_1', { valorFinal: 2606 }, owner);

        expect(tx.equipment.updateMany).toHaveBeenCalledWith({
          where: { id: 'e1', currentHourmeter: 4606 },
          data: { currentHourmeter: 2606 },
        });
      });
    });

    describe('operador', () => {
      it('valida al nuevo operador, rederiva el snapshot y lo registra por nombre', async () => {
        assertActive.mockResolvedValue({ id: 'op_2', name: 'Luis Pérez' });

        await service.update('card_1', { operatorId: 'op_2' }, owner);

        expect(assertActive).toHaveBeenCalledWith('op_2');
        expect(lastCallData(tx.registroHorometro.update)).toMatchObject({
          operatorId: 'op_2',
          operador: 'Luis Pérez',
        });
        expect(changeLog.record).toHaveBeenCalledWith(
          tx,
          'shift_card',
          'card_1',
          { id: 'sup_1', name: 'Ana Soto' },
          [
            {
              field: 'operatorId',
              label: 'Operador',
              before: 'Patricio Rojas',
              after: 'Luis Pérez',
            },
          ],
        );
      });

      it('un operador inactivo propaga el 409 sin escribir', async () => {
        assertActive.mockRejectedValue(
          new ConflictException({ code: 'OPERATOR_INACTIVE', message: 'x' }),
        );

        await expect(
          service.update('card_1', { operatorId: 'op_9' }, owner),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('si el operador no cambia no se exige que siga activo', async () => {
        await service.update(
          'card_1',
          { operatorId: 'op_1', observaciones: 'a' },
          owner,
        );

        expect(assertActive).not.toHaveBeenCalled();
      });
    });

    describe('AdBlue', () => {
      it('con AdBlue sin litros es 400', async () => {
        await expect(
          service.update('card_1', { adBlue: true }, owner),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(tx.registroHorometro.update).not.toHaveBeenCalled();
      });

      it('litros sin AdBlue es 400', async () => {
        await expect(
          service.update('card_1', { adBlueLiters: 10 }, owner),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('AdBlue en false con litros en el mismo body es 400', async () => {
        await expect(
          service.update('card_1', { adBlue: false, adBlueLiters: 5 }, owner),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('litros fuera de rango (> 1000) es 400', async () => {
        await expect(
          service.update('card_1', { adBlue: true, adBlueLiters: 1001 }, owner),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('agrega AdBlue con litros y lo registra con Sí/No legibles', async () => {
        await service.update(
          'card_1',
          { adBlue: true, adBlueLiters: 12.5 },
          owner,
        );

        expect(lastCallData(tx.registroHorometro.update)).toMatchObject({
          adBlue: true,
          adBlueLiters: 12.5,
        });
        expect(changeLog.record).toHaveBeenCalledWith(
          tx,
          'shift_card',
          'card_1',
          expect.anything(),
          [
            { field: 'adBlue', label: 'AdBlue', before: 'No', after: 'Sí' },
            {
              field: 'adBlueLiters',
              label: 'Litros de AdBlue',
              before: '—',
              after: '12,5',
            },
          ],
        );
      });

      it('con AdBlue ya cargado, cambiar solo los litros alcanza', async () => {
        givenCard(closedCard({ adBlue: true, adBlueLiters: 10 }));

        await service.update('card_1', { adBlueLiters: 20 }, owner);

        expect(lastCallData(tx.registroHorometro.update)).toMatchObject({
          adBlue: true,
          adBlueLiters: 20,
        });
      });

      it('quitar el AdBlue sin mandar litros los limpia', async () => {
        givenCard(closedCard({ adBlue: true, adBlueLiters: 10 }));

        await service.update('card_1', { adBlue: false }, owner);

        expect(lastCallData(tx.registroHorometro.update)).toMatchObject({
          adBlue: false,
          adBlueLiters: null,
        });
      });
    });

    describe('combustible vinculado', () => {
      it('0 -> 20 L sin carga vinculada: la crea con la foto, el tipo y la fecha de la tarjeta', async () => {
        await service.update('card_1', { fuelLiters: 20 }, owner);

        expect(tx.registroCombustible.create).toHaveBeenCalledTimes(1);
        expect(lastCallData(tx.registroCombustible.create)).toEqual({
          equipoId: 'e1',
          litros: 20,
          tipo: 'PETROLEO',
          fotoKey: 'fuel-photos/final.jpg',
          fecha: new Date('2026-09-28T19:55:00.000Z'),
          registroHorometroId: 'card_1',
        });
      });

      it('0 -> 20 L en una tarjeta NOCTURNA cerrada de MADRUGADA: la carga creada cae en el día del turno (regla del día de turno)', async () => {
        // 06:30Z = 03:30 en Chile (UTC-3): el nocturno que abrió el 28.
        givenCard(
          closedCard({
            turno: 'NOCTURNO',
            fechaSalida: new Date('2026-09-29T06:30:00.000Z'),
            shift: {
              id: 'shift_1',
              date: new Date('2026-09-28T00:00:00.000Z'),
              type: 'NOCTURNO',
              exitReports: [],
            },
          }),
        );

        await service.update('card_1', { fuelLiters: 20 }, owner);

        expect(
          (
            lastCallData(tx.registroCombustible.create).fecha as Date
          ).toISOString(),
        ).toBe('2026-09-28T23:30:00.000Z');
      });

      it('0 -> 20 L en un liviano cerrado en el turno de OTRO supervisor: la carga respeta el turno de quien cerró (closedShiftId)', async () => {
        givenCard(
          closedCard({
            closedShiftId: 'shift_2',
            // Cerrada a las 03:30 de Chile del 30 por un supervisor nocturno
            // cuyo turno es el del 29.
            fechaSalida: new Date('2026-09-30T06:30:00.000Z'),
          }),
        );
        tx.shift.findUnique.mockResolvedValue({
          date: new Date('2026-09-29T00:00:00.000Z'),
          type: 'NOCTURNO',
        });
        // `shapeCards` resuelve el turno de cierre (soft ref) para la respuesta.
        prisma.shift.findMany.mockResolvedValue([
          {
            id: 'shift_2',
            date: new Date('2026-09-29T00:00:00.000Z'),
            type: 'NOCTURNO',
          },
        ]);

        await service.update('card_1', { fuelLiters: 20 }, owner);

        expect(tx.shift.findUnique).toHaveBeenCalledWith({
          where: { id: 'shift_2' },
          select: { date: true, type: true },
        });
        expect(
          (
            lastCallData(tx.registroCombustible.create).fecha as Date
          ).toISOString(),
        ).toBe('2026-09-29T23:30:00.000Z');
      });

      it('20 -> 35 L con carga vinculada: actualiza los litros de esa fila', async () => {
        givenCard(closedCard({ fuelLiters: 20 }));
        tx.registroCombustible.findUnique.mockResolvedValue({ id: 'fuel_1' });

        await service.update('card_1', { fuelLiters: 35 }, owner);

        expect(tx.registroCombustible.update).toHaveBeenCalledWith({
          where: { id: 'fuel_1' },
          data: { litros: 35 },
        });
        expect(tx.registroCombustible.create).not.toHaveBeenCalled();
      });

      it('20 -> 0 L: borra la carga vinculada', async () => {
        givenCard(closedCard({ fuelLiters: 20 }));
        tx.registroCombustible.findUnique.mockResolvedValue({ id: 'fuel_1' });

        await service.update('card_1', { fuelLiters: 0 }, owner);

        expect(tx.registroCombustible.delete).toHaveBeenCalledWith({
          where: { id: 'fuel_1' },
        });
      });

      it('si los litros no cambian no toca la carga vinculada', async () => {
        givenCard(closedCard({ fuelLiters: 20 }));

        await service.update('card_1', { observaciones: 'a' }, owner);

        expect(tx.registroCombustible.findUnique).not.toHaveBeenCalled();
      });
    });

    describe('auditoría', () => {
      it('registra en la misma transacción y avisa después, con etiquetas legibles', async () => {
        await service.update('card_1', { observaciones: 'Cambio' }, owner);

        expect(changeLog.record).toHaveBeenCalledWith(
          tx,
          'shift_card',
          'card_1',
          { id: 'sup_1', name: 'Ana Soto' },
          [
            {
              field: 'observaciones',
              label: 'Observaciones',
              before: '—',
              after: 'Cambio',
            },
          ],
        );
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'record.edited',
          expect.objectContaining({
            entity: 'shift_card',
            entityId: 'card_1',
            editedBy: 'Ana Soto',
            changes: [{ label: 'Observaciones', before: '—', after: 'Cambio' }],
          }),
        );
        const [, event] = eventEmitter.emit.mock.calls[0] as [
          string,
          { entityLabel: string },
        ];
        expect(event.entityLabel).toContain('EX-001');
      });

      it('la etiqueta del aviso usa la fecha del TURNO y el artículo «la»', async () => {
        // Turno nocturno del 28/09 abierto ya pasada la medianoche UTC.
        givenCard(
          closedCard({
            fecha: new Date('2026-09-29T03:30:00.000Z'),
            shift: {
              id: 'shift_1',
              date: new Date('2026-09-28T00:00:00.000Z'),
              type: 'NOCTURNO',
              exitReports: [],
            },
          }),
        );

        await service.update('card_1', { observaciones: 'Cambio' }, owner);

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'record.edited',
          expect.objectContaining({
            entityArticle: 'la',
            entityLabel: 'tarjeta de turno de EX-001 del 28-09-2026',
          }),
        );
      });

      it('una tarjeta sin turno usa la fecha de apertura en horario de negocio', async () => {
        givenCard(
          closedCard({
            shift: null,
            shiftId: null,
            fecha: new Date('2026-09-29T02:30:00.000Z'),
          }),
        );

        await service.update('card_1', { observaciones: 'Cambio' }, owner);

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'record.edited',
          expect.objectContaining({
            entityLabel: 'tarjeta de turno de EX-001 del 28-09-2026',
          }),
        );
      });

      it('si nada cambió no escribe, no registra y no avisa', async () => {
        await service.update(
          'card_1',
          { valorFinal: 130, fuelLiters: 0, observaciones: '  ' },
          owner,
        );

        expect(tx.registroHorometro.update).not.toHaveBeenCalled();
        expect(tx.registroCombustible.create).not.toHaveBeenCalled();
        expect(changeLog.record).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('si la transacción falla no se avisa', async () => {
        changeLog.record.mockRejectedValue(new Error('db caída'));

        await expect(
          service.update('card_1', { observaciones: 'a' }, owner),
        ).rejects.toThrow('db caída');
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('responde la tarjeta con AdBlue', async () => {
        givenCard(closedCard({ adBlue: true, adBlueLiters: 10 }));

        const res = await service.update(
          'card_1',
          { adBlueLiters: 10, observaciones: 'a' },
          owner,
        );

        expect(res).toMatchObject({ adBlue: true, adBlueLiters: 10 });
      });
    });

    describe('turno y equipo', () => {
      it('en una ABIERTA también se corrige el turno: se mueve el shiftId sin tocar cierre ni contador', async () => {
        givenCard(
          closedCard({
            valorFinal: null,
            closedAt: null,
            fechaSalida: null,
            closedShiftId: null,
          }),
        );
        prisma.shift.upsert.mockResolvedValue({
          id: 'shift_2',
          supervisorId: 'sup_1',
          date: new Date('2026-09-28T00:00:00.000Z'),
          type: 'NOCTURNO',
        });

        await service.update('card_1', { turno: 'NOCTURNO' }, owner);

        const data = lastCallData(tx.registroHorometro.update);
        expect(data.turno).toBe('NOCTURNO');
        expect(data.shiftId).toBe('shift_2');
        expect(data.closedShiftId).toBeUndefined();
        expect(tx.equipment.updateMany).not.toHaveBeenCalled();
      });

      it('mover una ABIERTA a otro equipo exige que el destino esté libre: 409 EQUIPMENT_BUSY', async () => {
        givenCard(
          closedCard({ valorFinal: null, closedAt: null, fechaSalida: null }),
        );
        tx.equipment.findUnique.mockResolvedValue({
          internalCode: 'EX-002',
          equipmentClass: 'HEAVY',
          controlUnit: 'HOURS',
          currentHourmeter: 100,
          currentMileage: null,
        });
        tx.registroHorometro.findFirst.mockResolvedValue({
          supervisorId: 'sup_2',
          fecha: new Date('2026-09-28T08:00:00.000Z'),
        });
        tx.user.findUnique.mockResolvedValue({ name: 'Marta Díaz' });

        expect(
          await errorOf(service.update('card_1', { equipoId: 'e2' }, owner)),
        ).toMatchObject({ code: 'EQUIPMENT_BUSY' });
        expect(tx.registroHorometro.update).not.toHaveBeenCalled();
      });

      it('mover una ABIERTA a un equipo libre reconcilia su contador con la lectura INICIAL (como la apertura)', async () => {
        givenCard(
          closedCard({ valorFinal: null, closedAt: null, fechaSalida: null }),
        );
        tx.equipment.findUnique.mockResolvedValue({
          internalCode: 'EX-002',
          equipmentClass: 'HEAVY',
          controlUnit: 'HOURS',
          currentHourmeter: 50,
          currentMileage: null,
        });
        tx.registroHorometro.findFirst.mockResolvedValue(null);

        await service.update('card_1', { equipoId: 'e2' }, owner);

        expect(lastCallData(tx.registroHorometro.update)).toMatchObject({
          equipoId: 'e2',
        });
        // valorInicial = 100 sobre un contador en 50: sube a 100.
        expect(tx.equipment.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { currentHourmeter: 100 } }),
        );
      });

      describe('con cargas registradas con la tarjeta abierta (liviano)', () => {
        const cargas = [
          { ...CARGA_EN_CURSO, id: 'carga_1', lectura: 1250 },
          { ...CARGA_EN_CURSO, id: 'carga_2', lectura: 1300 },
        ];
        const EQUIPO_LIVIANO_INCLUDE = {
          ...EQUIPO_INCLUDE,
          controlUnit: 'KM',
          equipmentClass: 'LIGHT',
        };

        it('la inicial no puede quedar por encima de una carga: 400 INITIAL_ABOVE_FUEL_LOAD', async () => {
          givenCard(
            closedCard({
              valorInicial: 1200,
              valorFinal: 1400,
              equipo: EQUIPO_LIVIANO_INCLUDE,
              cargasEnCurso: cargas,
            }),
          );

          expect(
            await errorOf(
              service.update('card_1', { valorInicial: 1260 }, owner),
            ),
          ).toMatchObject({ code: 'INITIAL_ABOVE_FUEL_LOAD' });
          expect(tx.registroHorometro.update).not.toHaveBeenCalled();
        });

        it('la final no puede quedar por debajo de una carga: 400 READING_BELOW_FUEL_LOAD', async () => {
          givenCard(
            closedCard({
              valorInicial: 1200,
              valorFinal: 1400,
              equipo: EQUIPO_LIVIANO_INCLUDE,
              cargasEnCurso: cargas,
            }),
          );

          expect(
            await errorOf(
              service.update('card_1', { valorFinal: 1290 }, owner),
            ),
          ).toMatchObject({ code: 'READING_BELOW_FUEL_LOAD' });
          expect(tx.registroHorometro.update).not.toHaveBeenCalled();
        });

        it('una edición que no toca las lecturas no se valida contra las cargas (datos viejos no la traban)', async () => {
          // Dato viejo inconsistente: final por debajo de una carga.
          givenCard(
            closedCard({
              valorInicial: 1200,
              valorFinal: 1290,
              equipo: EQUIPO_LIVIANO_INCLUDE,
              cargasEnCurso: cargas,
            }),
          );

          await service.update(
            'card_1',
            { observaciones: 'Corrijo la nota' },
            owner,
          );

          expect(tx.registroHorometro.update).toHaveBeenCalledTimes(1);
        });

        it('mover la tarjeta a otro liviano mueve sus cargas, libera su km en el original y lo reconcilia en el destino', async () => {
          givenCard(
            closedCard({
              valorInicial: 1200,
              valorFinal: null,
              closedAt: null,
              fechaSalida: null,
              equipo: EQUIPO_LIVIANO_INCLUDE,
              cargasEnCurso: cargas,
            }),
          );
          tx.equipment.findUnique.mockImplementation(
            ({ where }: { where: { id: string } }) =>
              Promise.resolve(
                where.id === 'e2'
                  ? {
                      internalCode: 'CM-002',
                      equipmentClass: 'LIGHT',
                      controlUnit: 'KM',
                      currentHourmeter: null,
                      currentMileage: 1000,
                    }
                  : // El km del original lo había fijado la última carga.
                    {
                      controlUnit: 'KM',
                      currentHourmeter: null,
                      currentMileage: 1300,
                    },
              ),
          );
          tx.registroHorometro.findFirst.mockResolvedValue(null);
          tx.registroHorometro.aggregate.mockResolvedValue({
            _max: { valorInicial: 1200, valorFinal: null },
          });
          tx.registroCombustible.updateMany.mockResolvedValue({ count: 2 });

          await service.update('card_1', { equipoId: 'e2' }, owner);

          expect(tx.registroCombustible.updateMany).toHaveBeenCalledWith({
            where: { tarjetaEnCursoId: 'card_1' },
            data: { equipoId: 'e2' },
          });
          // Original: el km vuelve a la lectura más alta que le queda.
          expect(tx.equipment.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
              where: expect.objectContaining({
                id: 'e1',
                currentMileage: 1300,
              }) as unknown,
              data: { currentMileage: 1200 },
            }),
          );
          // Destino: sube hasta la carga más alta.
          expect(tx.equipment.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
              where: expect.objectContaining({ id: 'e2' }) as unknown,
              data: { currentMileage: 1300 },
            }),
          );
        });
      });

      it('mover el turno upsertea el Shift de destino (mismo día y supervisor) y mueve shiftId y closedShiftId', async () => {
        givenCard(closedCard({ closedShiftId: 'shift_1' }));
        prisma.shift.upsert.mockResolvedValue({
          id: 'shift_2',
          supervisorId: 'sup_1',
          date: new Date('2026-09-28T00:00:00.000Z'),
          type: 'NOCTURNO',
        });

        await service.update('card_1', { turno: 'NOCTURNO' }, owner);

        expect(prisma.shift.upsert).toHaveBeenCalledWith({
          where: {
            supervisorId_date_type: {
              supervisorId: 'sup_1',
              date: new Date('2026-09-28T00:00:00.000Z'),
              type: 'NOCTURNO',
            },
          },
          create: {
            supervisorId: 'sup_1',
            date: new Date('2026-09-28T00:00:00.000Z'),
            type: 'NOCTURNO',
          },
          update: {},
        });
        expect(lastCallData(tx.registroHorometro.update)).toMatchObject({
          turno: 'NOCTURNO',
          shiftId: 'shift_2',
          closedShiftId: 'shift_2',
        });
        expect(changeLog.record).toHaveBeenCalledWith(
          tx,
          'shift_card',
          'card_1',
          expect.anything(),
          [
            {
              field: 'turno',
              label: 'Turno',
              before: 'Diurno',
              after: 'Nocturno',
            },
          ],
        );
      });

      it('el cierre hecho en el turno de OTRO supervisor (liviano) no se mueve', async () => {
        givenCard(closedCard({ closedShiftId: 'shift_9' }));
        prisma.shift.upsert.mockResolvedValue({
          id: 'shift_2',
          supervisorId: 'sup_1',
          date: new Date('2026-09-28T00:00:00.000Z'),
          type: 'NOCTURNO',
        });

        await service.update('card_1', { turno: 'NOCTURNO' }, owner);

        const data = lastCallData(tx.registroHorometro.update);
        expect(data.shiftId).toBe('shift_2');
        expect(data.closedShiftId).toBeUndefined();
      });

      it('la carga vinculada se re-fecha con la regla del día de turno del destino', async () => {
        givenCard(closedCard({ fuelLiters: 20, closedShiftId: 'shift_1' }));
        tx.registroCombustible.findUnique.mockResolvedValue({ id: 'fuel_1' });
        prisma.shift.upsert.mockResolvedValue({
          id: 'shift_2',
          supervisorId: 'sup_1',
          date: new Date('2026-09-28T00:00:00.000Z'),
          type: 'NOCTURNO',
        });

        await service.update('card_1', { turno: 'NOCTURNO' }, owner);

        expect(tx.registroCombustible.update).toHaveBeenCalledWith({
          where: { id: 'fuel_1' },
          data: {
            fecha: fuelDateForShiftDay(
              new Date('2026-09-28T19:55:00.000Z'),
              '2026-09-28',
              'NOCTURNO',
            ),
          },
        });
      });

      it('si el turno del cierre es ajeno, la carga vinculada conserva su fecha', async () => {
        givenCard(closedCard({ fuelLiters: 20, closedShiftId: 'shift_9' }));
        tx.registroCombustible.findUnique.mockResolvedValue({ id: 'fuel_1' });
        prisma.shift.upsert.mockResolvedValue({
          id: 'shift_2',
          supervisorId: 'sup_1',
          date: new Date('2026-09-28T00:00:00.000Z'),
          type: 'NOCTURNO',
        });

        await service.update('card_1', { turno: 'NOCTURNO' }, owner);

        expect(tx.registroCombustible.update).not.toHaveBeenCalled();
      });

      it('una tarjeta legacy sin Shift solo corrige la columna turno (sin upsert)', async () => {
        givenCard(closedCard({ shift: null, shiftId: null }));

        await service.update('card_1', { turno: 'NOCTURNO' }, owner);

        expect(prisma.shift.upsert).not.toHaveBeenCalled();
        const data = lastCallData(tx.registroHorometro.update);
        expect(data.turno).toBe('NOCTURNO');
        expect(data.shiftId).toBeUndefined();
      });

      it('cambiar la máquina actualiza la tarjeta y la carga vinculada, y reconcilia el contador del equipo nuevo', async () => {
        givenCard(closedCard({ fuelLiters: 20 }));
        tx.equipment.findUnique.mockResolvedValue({
          internalCode: 'EX-002',
          equipmentClass: 'HEAVY',
          controlUnit: 'HOURS',
          currentHourmeter: 100,
          currentMileage: null,
        });
        tx.registroCombustible.findUnique.mockResolvedValue({ id: 'fuel_1' });

        await service.update('card_1', { equipoId: 'e2' }, owner);

        expect(lastCallData(tx.registroHorometro.update)).toMatchObject({
          equipoId: 'e2',
        });
        // La lectura final (130) vale sobre el equipo nuevo: su contador sube.
        expect(tx.equipment.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { currentHourmeter: 130 } }),
        );
        expect(tx.registroCombustible.update).toHaveBeenCalledWith({
          where: { id: 'fuel_1' },
          data: { equipoId: 'e2' },
        });
        expect(changeLog.record).toHaveBeenCalledWith(
          tx,
          'shift_card',
          'card_1',
          expect.anything(),
          [
            {
              field: 'equipoId',
              label: 'Equipo',
              before: 'EX-001',
              after: 'EX-002',
            },
          ],
        );
      });

      it('404 si el equipo nuevo no existe', async () => {
        tx.equipment.findUnique.mockResolvedValue(null);

        await expect(
          service.update('card_1', { equipoId: 'e9' }, owner),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(tx.registroHorometro.update).not.toHaveBeenCalled();
      });

      it('400 si el equipo nuevo es de otra clase (pesado vs liviano)', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          internalCode: 'CAM-01',
          equipmentClass: 'LIGHT',
          controlUnit: 'KILOMETERS',
          currentHourmeter: null,
          currentMileage: 10,
        });

        await expect(
          service.update('card_1', { equipoId: 'e2' }, owner),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(tx.registroHorometro.update).not.toHaveBeenCalled();
      });

      it('X-Expected sobre el equipo: 409 STALE_UPDATE si cambió por otro lado', async () => {
        const body = await errorOf(
          service.update('card_1', { equipoId: 'e2' }, owner, {
            equipoId: 'e_viejo',
          }),
        );

        expect(body).toMatchObject({
          code: 'STALE_UPDATE',
          message: expect.stringContaining('Equipo') as string,
        });
        expect(tx.registroHorometro.update).not.toHaveBeenCalled();
      });
    });

    describe('X-Expected', () => {
      it('con la base vigente aplica', async () => {
        await service.update('card_1', { valorFinal: 140 }, owner, {
          valorFinal: 130,
        });

        expect(tx.registroHorometro.update).toHaveBeenCalledTimes(1);
      });

      it('si el dato cambió por otro lado: 409 STALE_UPDATE nombrando el campo, sin escribir', async () => {
        const body = await errorOf(
          service.update('card_1', { valorFinal: 140 }, owner, {
            valorFinal: 125,
          }),
        );

        expect(body).toMatchObject({
          code: 'STALE_UPDATE',
          message: expect.stringContaining('Lectura final') as string,
        });
        expect(tx.registroHorometro.update).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('el reintento de una edición ya aplicada pasa y no repite escritura ni aviso', async () => {
        givenCard(closedCard({ valorFinal: 140 }));

        await service.update('card_1', { valorFinal: 140 }, owner, {
          valorFinal: 130,
        });

        expect(tx.registroHorometro.update).not.toHaveBeenCalled();
        expect(changeLog.record).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('un campo esperado que el body no toca no da ni falso pase ni conflicto', async () => {
        await service.update('card_1', { observaciones: 'a' }, owner, {
          valorFinal: 999,
        });

        expect(tx.registroHorometro.update).toHaveBeenCalledTimes(1);
      });

      it('compara el operador por id y el texto sin espacios', async () => {
        await service.update('card_1', { observaciones: 'a' }, owner, {
          operatorId: 'op_1',
          observaciones: '   ',
        });

        expect(tx.registroHorometro.update).toHaveBeenCalledTimes(1);
      });
    });

    it('bloquea la fila antes de releerla', async () => {
      await service.update('card_1', { observaciones: 'a' }, owner);

      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeCard (DELETE)', () => {
    const owner = buildSession('sup_1', 'SUPERVISOR', 'Ana Soto');

    function deletableCard(overrides: Record<string, unknown> = {}) {
      return buildCardRecord({
        valorFinal: 130,
        fuelLiters: 20,
        pumpPhotoKey: 'fuel-photos/final.jpg',
        closedAt: new Date('2026-09-28T20:00:00.000Z'),
        fechaSalida: new Date('2026-09-28T19:55:00.000Z'),
        ...overrides,
      });
    }

    async function errorOf(promise: Promise<unknown>): Promise<unknown> {
      try {
        await promise;
      } catch (error: unknown) {
        return (error as { getResponse: () => unknown }).getResponse();
      }
      throw new Error('se esperaba un error');
    }

    beforeEach(() => {
      prisma.registroHorometro.findUnique.mockResolvedValue(deletableCard());
      prisma.registroCombustible.findUnique.mockResolvedValue(null);
      // La tarjeta se bloquea y sus cargas en curso se releen en la tx.
      tx.$queryRaw.mockResolvedValue([{ id: 'card_1' }]);
      tx.registroCombustible.findMany.mockResolvedValue([]);
      tx.registroHorometro.delete.mockResolvedValue({});
      tx.registroCombustible.delete.mockResolvedValue({});
      changeLog.record.mockResolvedValue({});
      deleteBestEffort.mockResolvedValue(undefined);
    });

    it('404 CARD_NOT_FOUND si no existe', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue(null);

      expect(await errorOf(service.removeCard('x', owner))).toMatchObject({
        code: 'CARD_NOT_FOUND',
      });
    });

    it('403 NOT_OWNER para otro supervisor', async () => {
      expect(
        await errorOf(service.removeCard('card_1', buildSession('sup_2'))),
      ).toMatchObject({ code: 'NOT_OWNER' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('un ADMIN puede eliminar la tarjeta de otro', async () => {
      await service.removeCard(
        'card_1',
        buildSession('adm_1', 'ADMIN', 'Admin'),
      );

      expect(tx.registroHorometro.delete).toHaveBeenCalledWith({
        where: { id: 'card_1' },
      });
    });

    it('arrastra las cargas hechas con la tarjeta abierta: bloquea la tarjeta, las relee en la tx, historial, AdBlue de vuelta, borrado y su foto', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue(
        deletableCard({ fuelLiters: null, pumpPhotoKey: null }),
      );
      // Afuera no habría cargas (lectura vieja): manda la de la tx.
      tx.registroCombustible.findMany.mockResolvedValue([
        {
          id: 'carga_1',
          litros: 40,
          lectura: 1250,
          adBlueLitros: 5,
          fotoKey: 'fuel-photos/c1.jpg',
          fecha: new Date('2026-09-28T15:00:00.000Z'),
          createdAt: new Date('2026-09-28T15:00:00.000Z'),
          createdById: 'sup_2',
        },
        {
          id: 'carga_2',
          litros: 30,
          lectura: 1300,
          adBlueLitros: null,
          fotoKey: 'fuel-photos/c2.jpg',
          fecha: new Date('2026-09-28T18:00:00.000Z'),
          createdAt: new Date('2026-09-28T18:00:00.000Z'),
          createdById: 'sup_2',
        },
      ]);
      tx.registroCombustible.deleteMany.mockResolvedValue({ count: 2 });

      await service.removeCard('card_1', owner);

      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(tx.registroCombustible.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tarjetaEnCursoId: 'card_1' } }),
      );
      expect(tx.registroCombustible.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['carga_1', 'carga_2'] } },
      });
      const borradasDeCarga = (
        changeLog.record.mock.calls as unknown as Array<
          [unknown, string, string, unknown, unknown, string?]
        >
      ).filter(([, entity, , , , action]) => {
        return entity === 'combustible' && action === 'DELETE';
      });
      expect(borradasDeCarga.map(([, , id]) => id)).toEqual([
        'carga_1',
        'carga_2',
      ]);
      // Solo la carga con AdBlue lo devuelve.
      expect(adBlueStock.restoreLoad).toHaveBeenCalledTimes(1);
      expect(adBlueStock.restoreLoad).toHaveBeenCalledWith(
        expect.objectContaining({ tx }),
        expect.objectContaining({ liters: 5, reference: 'carga_1' }),
      );
      expect(deleteBestEffort).toHaveBeenCalledWith('fuel-photos/c1.jpg');
      expect(deleteBestEffort).toHaveBeenCalledWith('fuel-photos/c2.jpg');
    });

    it('si una carga en curso ya no está al borrar (borrado concurrente), revierte con STALE_UPDATE y no suelta fotos', async () => {
      tx.registroCombustible.findMany.mockResolvedValue([
        {
          id: 'carga_1',
          litros: 40,
          lectura: 1250,
          adBlueLitros: 5,
          fotoKey: 'fuel-photos/c1.jpg',
          fecha: new Date('2026-09-28T15:00:00.000Z'),
          createdAt: new Date('2026-09-28T15:00:00.000Z'),
          createdById: 'sup_2',
        },
        {
          id: 'carga_2',
          litros: 30,
          lectura: 1300,
          adBlueLitros: null,
          fotoKey: 'fuel-photos/c2.jpg',
          fecha: new Date('2026-09-28T18:00:00.000Z'),
          createdAt: new Date('2026-09-28T18:00:00.000Z'),
          createdById: 'sup_2',
        },
      ]);
      tx.registroCombustible.deleteMany.mockResolvedValue({ count: 1 });

      await expect(service.removeCard('card_1', owner)).rejects.toMatchObject({
        response: { code: 'STALE_UPDATE' },
      });
      expect(tx.registroHorometro.delete).not.toHaveBeenCalled();
      expect(deleteBestEffort).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('si la tarjeta desapareció al bloquearla, 404 sin borrar nada', async () => {
      tx.$queryRaw.mockResolvedValue([]);

      await expect(service.removeCard('card_1', owner)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tx.registroHorometro.delete).not.toHaveBeenCalled();
    });

    it('eliminar la tarjeta cuya lectura había fijado el contador lo devuelve a la más alta que queda', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue(
        deletableCard({ valorInicial: 4600, valorFinal: 4606 }),
      );
      tx.equipment.findUnique.mockResolvedValue({
        controlUnit: 'HOURS',
        currentHourmeter: 4606,
        currentMileage: null,
      });
      tx.registroHorometro.aggregate.mockResolvedValue({
        _max: { valorInicial: 2600, valorFinal: 2628 },
      });

      await service.removeCard('card_1', owner);

      expect(tx.equipment.updateMany).toHaveBeenCalledWith({
        where: { id: 'e1', currentHourmeter: 4606 },
        data: { currentHourmeter: 2628 },
      });
    });

    it('eliminar una tarjeta con AdBlue devuelve sus litros al saldo', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue(
        deletableCard({ adBlue: true, adBlueLiters: 30 }),
      );

      await service.removeCard('card_1', owner);

      expect(adBlueStock.restoreLoad).toHaveBeenCalledWith(
        { tx, events: [] },
        expect.objectContaining({ liters: 30, reference: 'card_1' }),
      );
    });

    it('sin AdBlue el borrado no toca el inventario', async () => {
      await service.removeCard('card_1', owner);

      expect(adBlueStock.restoreLoad).not.toHaveBeenCalled();
    });

    it('una ABIERTA también se elimina: libera el slot y la asignación del equipo, con «—» en lo que no tiene', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue(
        deletableCard({
          valorFinal: null,
          fuelLiters: null,
          pumpPhotoKey: null,
          closedAt: null,
          fechaSalida: null,
        }),
      );

      await service.removeCard('card_1', owner);

      expect(tx.registroHorometro.delete).toHaveBeenCalledWith({
        where: { id: 'card_1' },
      });
      expect(tx.equipment.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { currentOperatorId: null, currentSupervisorId: null },
      });
      expect(deleteBestEffort).not.toHaveBeenCalled();
      const llamada = changeLog.record.mock.calls.find(
        (c: unknown[]) => c[1] === 'shift_card',
      ) as unknown[];
      expect(llamada[4]).toEqual(
        expect.arrayContaining([
          {
            field: 'valorFinal',
            label: 'Lectura final',
            before: '—',
            after: '—',
          },
        ]),
      );
    });

    it('borra la tarjeta y su carga vinculada, deja el rastro DELETE y avisa con «eliminó»', async () => {
      prisma.registroCombustible.findUnique.mockResolvedValue({
        id: 'fuel_1',
        litros: 20,
        fecha: new Date('2026-09-28T19:55:00.000Z'),
      });

      await service.removeCard('card_1', owner);

      expect(changeLog.record).toHaveBeenCalledWith(
        tx,
        'shift_card',
        'card_1',
        { id: 'sup_1', name: 'Ana Soto' },
        [
          { field: 'equipoId', label: 'Equipo', before: 'EX-001', after: '—' },
          {
            field: 'operatorId',
            label: 'Operador',
            before: 'Patricio Rojas',
            after: '—',
          },
          {
            field: 'turno',
            label: 'Turno',
            before: 'Diurno del 28-09-2026',
            after: '—',
          },
          {
            field: 'valorInicial',
            label: 'Lectura inicial',
            before: '100',
            after: '—',
          },
          {
            field: 'valorFinal',
            label: 'Lectura final',
            before: '130',
            after: '—',
          },
          {
            field: 'fuelLiters',
            label: 'Litros de combustible',
            before: '20',
            after: '—',
          },
        ],
        'DELETE',
      );
      expect(changeLog.record).toHaveBeenCalledWith(
        tx,
        'combustible',
        'fuel_1',
        { id: 'sup_1', name: 'Ana Soto' },
        [
          { field: 'equipo', label: 'Equipo', before: 'EX-001', after: '—' },
          { field: 'litros', label: 'Litros', before: '20', after: '—' },
          {
            field: 'fecha',
            label: 'Fecha',
            before: expect.any(String) as string,
            after: '—',
          },
          {
            field: 'origen',
            label: 'Origen',
            before: 'Cierre de tarjeta',
            after: '—',
          },
        ],
        'DELETE',
      );
      expect(tx.registroCombustible.delete).toHaveBeenCalledWith({
        where: { id: 'fuel_1' },
      });
      expect(tx.registroHorometro.delete).toHaveBeenCalledWith({
        where: { id: 'card_1' },
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'record.edited',
        expect.objectContaining({
          entity: 'shift_card',
          entityId: 'card_1',
          deleted: true,
          editedBy: 'Ana Soto',
          entityLabel: 'tarjeta de turno de EX-001 del 28-09-2026',
        }),
      );
      expect(deleteBestEffort).toHaveBeenCalledWith('fuel-photos/final.jpg');
      // Cerrada: el equipo ya estaba libre, su asignación no se toca.
      expect(tx.equipment.update).not.toHaveBeenCalled();
    });

    it('sin carga vinculada ni foto no toca combustible ni el bucket', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue(
        deletableCard({ pumpPhotoKey: null }),
      );

      await service.removeCard('card_1', owner);

      expect(tx.registroCombustible.delete).not.toHaveBeenCalled();
      expect(deleteBestEffort).not.toHaveBeenCalled();
      expect(tx.registroHorometro.delete).toHaveBeenCalledTimes(1);
    });

    it('si la transacción falla no avisa ni suelta la foto', async () => {
      changeLog.record.mockRejectedValue(new Error('db caída'));

      await expect(service.removeCard('card_1', owner)).rejects.toThrow(
        'db caída',
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(deleteBestEffort).not.toHaveBeenCalled();
    });
  });

  describe('findChanges', () => {
    beforeEach(() => {
      prisma.registroHorometro.findUnique.mockResolvedValue({
        supervisorId: 'sup_1',
        operatorId: 'op_1',
        valorFinal: 130,
      });
    });

    it('el dueño lee el historial de su tarjeta', async () => {
      changeLog.findFor.mockResolvedValue([{ id: 'c1' }]);

      const res = await service.findChanges('card_1', buildSession('sup_1'));

      expect(changeLog.findFor).toHaveBeenCalledWith('shift_card', 'card_1');
      expect(res).toEqual([{ id: 'c1' }]);
    });

    it('un ADMIN lo lee aunque no sea el dueño', async () => {
      changeLog.findFor.mockResolvedValue([]);

      await service.findChanges('card_1', buildSession('adm', 'ADMIN'));

      expect(changeLog.findFor).toHaveBeenCalled();
    });

    it('otro supervisor: 403 NOT_OWNER', async () => {
      await expect(
        service.findChanges('card_1', buildSession('sup_2')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(changeLog.findFor).not.toHaveBeenCalled();
    });

    it('404 si la tarjeta no existe', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue(null);

      await expect(
        service.findChanges('x', buildSession('sup_1')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('mine', () => {
    it('SUPERVISOR ve las suyas, los livianos abiertos y los livianos que él cerró', async () => {
      prisma.registroHorometro.findMany.mockResolvedValue([]);

      await service.mine(buildSession('sup_1'));

      const [args] = prisma.registroHorometro.findMany.mock.calls[0] as [
        { where: { AND: [Record<string, unknown>, unknown] } },
      ];
      expect(args.where.AND[0]).toEqual({
        OR: [
          { supervisorId: 'sup_1' },
          {
            equipo: { equipmentClass: 'LIGHT' },
            // Un liviano temporal ajeno es privado (y no lo puede cerrar).
            temporal: false,
            OR: [{ valorFinal: null }, { closedById: 'sup_1' }],
          },
        ],
      });
    });

    it('ADMIN ve todas (sin filtro de supervisorId)', async () => {
      prisma.registroHorometro.findMany.mockResolvedValue([]);

      await service.mine(buildSession('admin_1', 'ADMIN'));

      const [args] = prisma.registroHorometro.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(args.where).not.toHaveProperty('supervisorId');
    });

    it('incluye abiertas + cerradas en las últimas 48h', async () => {
      prisma.registroHorometro.findMany.mockResolvedValue([]);

      await service.mine(buildSession('sup_1'));

      const [args] = prisma.registroHorometro.findMany.mock.calls[0] as [
        {
          where: {
            AND: [
              unknown,
              { OR: [{ valorFinal: null }, { closedAt: { gte: unknown } }] },
            ];
          };
        },
      ];
      expect(args.where.AND[1].OR[0]).toEqual({ valorFinal: null });
      expect(args.where.AND[1].OR[1].closedAt.gte).toBeInstanceOf(Date);
    });

    it('el shape público no incluye pumpPhotoKey ni closeClientId', async () => {
      prisma.registroHorometro.findMany.mockResolvedValue([
        buildCardRecord({
          pumpPhotoKey: 'fuel-photos/x.jpg',
          closeClientId: 'close_1',
        }),
      ]);

      const [card] = await service.mine(buildSession('sup_1'));

      expect(card).not.toHaveProperty('pumpPhotoKey');
      expect(card).not.toHaveProperty('closeClientId');
      expect(card.pumpPhotoUrl).toBe('https://signed/fuel-photos/x.jpg');
    });

    it('horasMaquina = valorFinal - valorInicial, null si sigue abierta', async () => {
      prisma.registroHorometro.findMany.mockResolvedValue([
        buildCardRecord({ id: 'cerrada', valorInicial: 100, valorFinal: 130 }),
        buildCardRecord({ id: 'abierta', valorInicial: 50, valorFinal: null }),
      ]);

      const [cerrada, abierta] = await service.mine(buildSession('sup_1'));

      expect(cerrada.horasMaquina).toBe(30);
      expect(abierta.horasMaquina).toBeNull();
    });

    it('la fecha del turno se devuelve como string YYYY-MM-DD', async () => {
      prisma.registroHorometro.findMany.mockResolvedValue([buildCardRecord()]);

      const [card] = await service.mine(buildSession('sup_1'));

      expect(card.shift?.date).toBe('2026-09-28');
    });
  });

  describe('findShifts', () => {
    it('SUPERVISOR ve solo sus turnos', async () => {
      prisma.shift.findMany.mockResolvedValue([]);

      await service.findShifts(
        { date: '2026-09-28', type: 'DIURNO' },
        buildSession('sup_1'),
      );

      const [args] = prisma.shift.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(args.where).toMatchObject({ supervisorId: 'sup_1' });
    });

    it('ADMIN ve todos los turnos de esa fecha/tipo (sin filtro de supervisorId)', async () => {
      prisma.shift.findMany.mockResolvedValue([]);

      await service.findShifts(
        { date: '2026-09-28', type: 'DIURNO' },
        buildSession('admin_1', 'ADMIN'),
      );

      const [args] = prisma.shift.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(args.where).not.toHaveProperty('supervisorId');
    });

    it('la fecha se devuelve como string', async () => {
      prisma.shift.findMany.mockResolvedValue([
        {
          id: 'shift_1',
          date: new Date('2026-09-28T00:00:00.000Z'),
          type: 'DIURNO',
          supervisorId: 'sup_1',
          cards: [],
          exitReports: [],
        },
      ]);

      const [shift] = await service.findShifts(
        { date: '2026-09-28', type: 'DIURNO' },
        buildSession('sup_1'),
      );

      expect(shift.date).toBe('2026-09-28');
    });

    it('las tarjetas del resumen traen la clase del equipo (para excluir camionetas en el front)', async () => {
      prisma.shift.findMany.mockResolvedValue([
        {
          id: 'shift_1',
          date: new Date('2026-09-28T00:00:00.000Z'),
          type: 'DIURNO',
          supervisorId: 'sup_1',
          cards: [
            {
              id: 'c1',
              equipoId: 'e1',
              equipo: {
                internalCode: 'EX-005',
                type: 'Excavadora',
                controlUnit: 'HOURS',
                equipmentClass: 'HEAVY',
              },
              operatorId: 'op_1',
              operador: 'Patricio Rojas',
              valorInicial: 100,
              valorFinal: 110,
              fecha: new Date('2026-09-28T12:00:00.000Z'),
              fechaSalida: new Date('2026-09-28T12:00:00.000Z'),
            },
          ],
          exitReports: [],
        },
      ]);

      const [shift] = await service.findShifts(
        { date: '2026-09-28', type: 'DIURNO' },
        buildSession('sup_1'),
      );

      expect(shift.cards[0].equipo).toMatchObject({ equipmentClass: 'HEAVY' });
      const [args] = prisma.shift.findMany.mock.calls[0] as [
        {
          include: {
            cards: { include: { equipo: { select: Record<string, boolean> } } };
          };
        },
      ];
      expect(args.include.cards.include.equipo.select).toHaveProperty(
        'equipmentClass',
        true,
      );
    });

    it('incluye los reportes de salida ya enviados del turno', async () => {
      const requestedAt = new Date('2026-09-28T20:05:00.000Z');
      prisma.shift.findMany.mockResolvedValue([
        {
          id: 'shift_1',
          date: new Date('2026-09-28T00:00:00.000Z'),
          type: 'DIURNO',
          supervisorId: 'sup_1',
          cards: [],
          exitReports: [{ id: 'rep_1', requestedAt, cardCount: 4 }],
        },
      ]);

      const [shift] = await service.findShifts(
        { date: '2026-09-28', type: 'DIURNO' },
        buildSession('sup_1'),
      );

      expect(shift.exitReports).toEqual([
        { id: 'rep_1', requestedAt, cardCount: 4 },
      ]);
      // El include pide exitReports junto con las tarjetas.
      const [args] = prisma.shift.findMany.mock.calls[0] as [
        { include: Record<string, unknown> },
      ];
      expect(args.include).toHaveProperty('exitReports');
    });
  });

  /**
   * SUPERVISOR_TEMPORAL: horario libre. Abre una tarjeta por equipo sin la
   * ventana de `shiftDate` ni `Shift`, y las cierra todas juntas con su
   * informe (`closeCard(..., { viaInforme: true })`). Sus tarjetas no las ve
   * ni las cierra el resto de los supervisores.
   */
  describe('supervisor temporal', () => {
    const temporal = buildSession('tmp_1', 'SUPERVISOR_TEMPORAL');
    const openDto: OpenShiftCardDto = {
      id: 'card_t1',
      equipoId: 'e1',
      operatorId: 'op_1',
      valorInicial: 100,
      shiftDate: todayShiftDate(),
      shiftType: 'DIURNO',
      capturedAt: iso(),
    };

    it('openCard como SUPERVISOR_TEMPORAL no crea Shift y marca temporal', async () => {
      await service.openCard(openDto, temporal);

      expect(prisma.shift.upsert).not.toHaveBeenCalled();
      expect(lastCallData(tx.registroHorometro.create)).toMatchObject({
        temporal: true,
        shiftId: null,
        supervisorId: 'tmp_1',
        turno: 'DIURNO',
      });
    });

    it('openCard temporal acepta shiftDate fuera de ventana', async () => {
      await expect(
        service.openCard(
          { ...openDto, shiftDate: todayShiftDate(-40) },
          temporal,
        ),
      ).resolves.toBeDefined();
    });

    describe('reloj fijo', () => {
      beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        // 02:00 en Chile: sigue corriendo el día de turno anterior.
        jest.setSystemTime(new Date('2026-11-24T05:00:00.000Z'));
      });
      afterEach(() => jest.useRealTimers());

      it('openCard temporal a las 02:00 busca el checklist del día anterior', async () => {
        await service.openCard(
          { ...openDto, shiftDate: '2026-11-24', capturedAt: iso() },
          temporal,
        );

        const esperado = {
          where: {
            equipmentId_date: {
              equipmentId: 'e1',
              date: new Date('2026-11-23T00:00:00.000Z'),
            },
          },
          select: { status: true },
        };
        expect(prisma.dailyChecklist.findUnique).toHaveBeenCalledWith(esperado);
        expect(tx.dailyChecklist.findUnique).toHaveBeenCalledWith(esperado);
        // Ni el día del dto ni ningún otro.
        expect(prisma.dailyChecklist.findUnique).toHaveBeenCalledTimes(1);
        expect(tx.dailyChecklist.findUnique).toHaveBeenCalledTimes(1);
      });
    });

    it('openCard temporal con equipo ocupado da EQUIPMENT_BUSY', async () => {
      tx.registroHorometro.findFirst.mockResolvedValue({
        supervisorId: 'otro_sup',
        fecha: new Date(),
      });
      tx.user.findUnique.mockResolvedValue({ name: 'Ana Torres' });

      await expect(service.openCard(openDto, temporal)).rejects.toMatchObject({
        response: { code: 'EQUIPMENT_BUSY' },
      });
      expect(tx.registroHorometro.create).not.toHaveBeenCalled();
    });

    describe('cierre', () => {
      const closeDto: CloseShiftCardDto = {
        closeClientId: 'close_t1',
        valorFinal: 130,
        fuelLiters: 0,
        noFuelReason: 'Sin carga',
        capturedAt: iso(),
      };

      beforeEach(() => {
        prisma.registroHorometro.findUnique.mockResolvedValue({
          id: 'card_t1',
          equipoId: 'e1',
          valorInicial: 100,
          valorFinal: null,
          supervisorId: 'tmp_1',
          closeClientId: null,
          closedAt: null,
          temporal: true,
          turno: 'DIURNO',
          shift: null,
          fecha: new Date(),
          createdAt: new Date(),
          clientClockSkewMs: null,
          belowPreviousReading: false,
        });
        prisma.equipment.findUnique.mockResolvedValue({
          equipmentClass: 'LIGHT',
        });
        tx.equipment.findUnique.mockResolvedValue({
          controlUnit: 'KM',
          currentHourmeter: null,
          currentMileage: 100,
        });
        tx.registroHorometro.findUnique.mockResolvedValue(
          buildCardRecord({
            id: 'card_t1',
            valorFinal: 130,
            shiftId: null,
            shift: null,
            equipo: { ...EQUIPO_INCLUDE, equipmentClass: 'LIGHT' },
          }),
        );
      });

      it('closeCard de tarjeta temporal por un SUPERVISOR da 409 TEMPORAL_CARD', async () => {
        await expect(
          service.closeCard(
            'card_t1',
            { ...closeDto, shiftDate: todayShiftDate(), shiftType: 'DIURNO' },
            buildSession('sup_1'),
          ),
        ).rejects.toMatchObject({ response: { code: 'TEMPORAL_CARD' } });
        expect(tx.registroHorometro.updateMany).not.toHaveBeenCalled();
      });

      it('closeCard de su propia tarjeta temporal sin viaInforme también da 409', async () => {
        await expect(
          service.closeCard('card_t1', closeDto, temporal),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('ADMIN sí puede cerrar una tarjeta temporal sin informe, sin turno y con closedShiftId null', async () => {
        // Sin shiftDate/shiftType: la temporal nunca entra a un turno, ni al
        // del ADMIN que la cierra (no se filtra a un reporte de salida).
        await expect(
          service.closeCard(
            'card_t1',
            closeDto,
            buildSession('admin_1', 'ADMIN'),
          ),
        ).resolves.toBeDefined();

        expect(prisma.shift.upsert).not.toHaveBeenCalled();
        expect(lastCallData(tx.registroHorometro.updateMany)).toMatchObject({
          closedById: 'admin_1',
          closedShiftId: null,
        });
      });

      it('closeCard con viaInforme cierra la temporal sin turno y closedShiftId null', async () => {
        await service.closeCard('card_t1', closeDto, temporal, {
          viaInforme: true,
        });

        expect(prisma.shift.upsert).not.toHaveBeenCalled();
        expect(lastCallData(tx.registroHorometro.updateMany)).toMatchObject({
          valorFinal: 130,
          closedById: 'tmp_1',
          closedShiftId: null,
        });
      });

      it('viaInforme no salta el chequeo de dueño: otro supervisor da 403', async () => {
        await expect(
          service.closeCard('card_t1', closeDto, buildSession('sup_1'), {
            viaInforme: true,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    it('addFuelLoad en tarjeta temporal da 409 TEMPORAL_CARD', async () => {
      prisma.registroCombustible.findUnique.mockResolvedValue(null);
      prisma.registroHorometro.findUnique.mockResolvedValue({
        equipoId: 'e1',
        valorInicial: 1200,
        valorFinal: null,
        closedAt: null,
        temporal: true,
        equipo: {
          equipmentClass: 'LIGHT',
          controlUnit: 'KM',
          currentHourmeter: null,
          currentMileage: 1200,
        },
      });

      await expect(
        service.addFuelLoad(
          'card_t1',
          {
            id: '44444444-4444-4444-8444-444444444444',
            liters: 45,
            reading: 1250,
            tmpPhotoKey: 'tmp/admin_1/11111111-1111-4111-8111-111111111111.jpg',
            capturedAt: iso(),
          },
          // Ni el ADMIN: la carga va en el informe.
          buildSession('admin_1', 'ADMIN'),
        ),
      ).rejects.toMatchObject({ response: { code: 'TEMPORAL_CARD' } });
      expect(claimTmp).not.toHaveBeenCalled();
    });

    it('mine de SUPERVISOR excluye livianos temporales ajenos', async () => {
      prisma.registroHorometro.findMany.mockResolvedValue([]);

      await service.mine(buildSession('sup_1'));

      const [args] = prisma.registroHorometro.findMany.mock.calls[0] as [
        { where: { AND: [{ OR: Array<Record<string, unknown>> }, unknown] } },
      ];
      expect(args.where.AND[0].OR[1]).toMatchObject({
        equipo: { equipmentClass: 'LIGHT' },
        temporal: false,
      });
    });

    it('mine de SUPERVISOR_TEMPORAL solo trae las suyas temporales', async () => {
      prisma.registroHorometro.findMany.mockResolvedValue([]);

      await service.mine(temporal);

      const [args] = prisma.registroHorometro.findMany.mock.calls[0] as [
        { where: { AND: [Record<string, unknown>, unknown] } },
      ];
      expect(args.where.AND[0]).toEqual({
        supervisorId: 'tmp_1',
        temporal: true,
      });
    });
  });
});
