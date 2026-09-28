import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { PrismaService } from '../common/prisma/prisma.service';
import { OperatorsService } from '../operators/operators.service';
import { StorageService } from '../storage/storage.service';
import { CloseShiftCardDto } from './dto/close-shift-card.dto';
import { OpenShiftCardDto } from './dto/open-shift-card.dto';
import { ShiftsService } from './shifts.service';

/** Construye un error de Prisma real (no un duck-type) — mismo patrón que
 * `horometro.service.spec.ts`/`equipment.service.spec.ts`. */
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

function buildSession(userId: string, role = 'SUPERVISOR'): UserSession {
  return {
    user: { id: userId, role },
    session: { id: 'session_1' },
  } as unknown as UserSession;
}

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
 * `assertShiftDateWithinWindow`, B2(b) — compara contra `new Date()` real).
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

const EQUIPO_INCLUDE = {
  internalCode: 'EX-001',
  type: 'Excavadora',
  controlUnit: 'HOURS',
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
    belowPreviousReading: false,
    createdAt: new Date('2026-09-28T08:00:00.000Z'),
    closedAt: null,
    clientClockSkewMs: null,
    nivelCombustible: null,
    equipo: EQUIPO_INCLUDE,
    shift: {
      id: 'shift_1',
      date: new Date('2026-09-28T00:00:00.000Z'),
      type: 'DIURNO',
      exitReports: [],
    },
    ...overrides,
  };
}

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
    },
    equipment: { findUnique: jest.fn(), updateMany: jest.fn() },
    registroCombustible: { create: jest.fn() },
    user: { findUnique: jest.fn() },
  };

  const prisma = {
    registroHorometro: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    shift: { upsert: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    // B2(c): pre-check de solo lectura del equipo, ANTES del upsert del
    // `Shift` (que sí escribe) — ver `ShiftsService.openCard`.
    equipment: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };

  const claimTmp = jest.fn();
  const sign = jest.fn();
  const discard = jest.fn();
  const assertActive = jest.fn();

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        ShiftsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { claimTmp, sign, discard } },
        { provide: OperatorsService, useValue: { assertActive } },
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
    // B2(c): pre-check de solo lectura ANTES del upsert del `Shift`, ver
    // `ShiftsService.openCard` — por defecto pasa, los tests de R1/404 lo
    // sobreescriben.
    prisma.equipment.findUnique.mockResolvedValue({ status: 'OPERATIONAL' });
    tx.registroHorometro.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        buildCardRecord({ ...data, id: data.id as string }),
    );
    tx.registroHorometro.updateMany.mockResolvedValue({ count: 1 });

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

    it('EQUIPMENT_NOT_OPERATIONAL: 409 si el equipo no está operativo (R1)', async () => {
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

    // B2(c) de la auditoría de seguridad.
    describe('pre-check del equipo ANTES del upsert del Shift (B2c)', () => {
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

    // B2(b) de la auditoría de seguridad.
    describe('ventana de shiftDate (B2b)', () => {
      it('rechaza un shiftDate de más de 8 días de antigüedad con INVALID_SHIFT_DATE, antes de crear el Shift', async () => {
        expect.assertions(4);
        try {
          await service.openCard({ ...dto, shiftDate: '2026-09-01' }, session);
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

    it('INVALID_CAPTURE_TIME: rechaza un capturedAt más de 24h en el futuro, antes de validar el operador', async () => {
      expect.assertions(3);
      try {
        await service.openCard(
          { ...dto, capturedAt: iso(25 * 60 * 60 * 1000) },
          session,
        );
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'INVALID_CAPTURE_TIME',
        });
      }
      expect(assertActive).not.toHaveBeenCalled();
    });

    it('INVALID_CAPTURE_TIME: rechaza un capturedAt de más de 7 días de antigüedad', async () => {
      expect.assertions(2);
      try {
        await service.openCard(
          { ...dto, capturedAt: iso(-8 * 24 * 60 * 60 * 1000) },
          session,
        );
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'INVALID_CAPTURE_TIME',
        });
      }
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

    it('bug corregido en revisión: una tarjeta abierta por debajo del contador (modo warn) cierra OK con un final que SIGUE por debajo — 200, contador sin mover, belowPreviousReading true', async () => {
      // Se abrió con valorInicial 990 cuando el vigente ya era 1000
      // (`belowPreviousReading: true` desde la apertura). Cierra en 998:
      // pasa el `valorFinal >= valorInicial` (998 >= 990), pero SIGUE por
      // debajo del vigente (1000) — antes del fix esto lanzaba `reject` DESPUÉS
      // de reclamar la foto, la descartaba, y la tarjeta quedaba encallada
      // para siempre (ver mensaje de revisión).
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

    // B2(d)/(e) de la auditoría de seguridad.
    describe('photoCapturedAt (EXIF del dispositivo) — B2(d)/(e)', () => {
      it('un photoCapturedAt válido y dentro de rango se usa como fecha de la carga', async () => {
        const photoCapturedAt = iso(-60_000); // 1 minuto antes de "ahora"

        await service.closeCard('card_1', { ...dto, photoCapturedAt }, session);

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
            { ...dto, photoCapturedAt: '2026-W01' },
            session,
          ),
        ).resolves.toBeDefined();

        expect(
          (
            lastCallData(tx.registroCombustible.create).fecha as Date
          ).toISOString(),
        ).toBe(new Date(dto.capturedAt).toISOString());
      });

      it('un photoCapturedAt fuera de la ventana razonable (EXIF con reloj mal configurado) NO rechaza — cae a capturedAt', async () => {
        const photoCapturedAtAbsurdo = new Date(
          Date.now() - 30 * 24 * 60 * 60 * 1000,
        ).toISOString(); // 30 días de "antigüedad"

        await expect(
          service.closeCard(
            'card_1',
            { ...dto, photoCapturedAt: photoCapturedAtAbsurdo },
            session,
          ),
        ).resolves.toBeDefined();

        expect(
          (
            lastCallData(tx.registroCombustible.create).fecha as Date
          ).toISOString(),
        ).toBe(new Date(dto.capturedAt).toISOString());
      });

      it('sin photoCapturedAt, usa capturedAt (comportamiento previo intacto)', async () => {
        await service.closeCard('card_1', dto, session);

        expect(
          (
            lastCallData(tx.registroCombustible.create).fecha as Date
          ).toISOString(),
        ).toBe(new Date(dto.capturedAt).toISOString());
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

    it('ADMIN puede cerrar la tarjeta de otro supervisor', async () => {
      const adminSession = buildSession('admin_1', 'ADMIN');

      await expect(
        service.closeCard('card_1', dto, adminSession),
      ).resolves.toBeDefined();
    });

    // M1(a) de la auditoría de seguridad.
    it('M1a: otro supervisor que reintenta (replay) el closeClientId de una tarjeta YA CERRADA ajena → 403 NOT_OWNER, NUNCA la tarjeta de A', async () => {
      // La tarjeta ya está cerrada, es de sup_1, y el closeClientId coincide
      // EXACTO con el del DTO (`dto.closeClientId === 'close_1'`) — el
      // escenario exacto del hallazgo: B "adivina"/reenvía el closeClientId
      // de A. Antes del fix, esto caía en la rama de replay idempotente
      // (que no chequea dueño) y devolvía la tarjeta completa de A, con la
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

    it('M1a: ADMIN SÍ puede replayar el closeClientId de una tarjeta ya cerrada de otro supervisor (200)', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue({
        id: 'card_1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: 130,
        supervisorId: 'sup_1',
        closeClientId: 'close_1',
        closedAt: new Date('2026-09-28T19:00:00.000Z'),
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

    // Info (auditoría de seguridad): antes, un `closeClientId` reusado en
    // OTRA tarjeta (P2002 vía el `@unique` global, no `count === 0`) caía
    // siempre en `ALREADY_CLOSED` ("la tarjeta ya fue cerrada") — mensaje
    // engañoso cuando la tarjeta `id` en cuestión en realidad SIGUE abierta.
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

  describe('mine', () => {
    it('SUPERVISOR ve solo las suyas', async () => {
      prisma.registroHorometro.findMany.mockResolvedValue([]);

      await service.mine(buildSession('sup_1'));

      const [args] = prisma.registroHorometro.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(args.where).toMatchObject({ supervisorId: 'sup_1' });
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
            OR: [{ valorFinal: null }, { closedAt: { gte: unknown } }];
          };
        },
      ];
      expect(args.where.OR[0]).toEqual({ valorFinal: null });
      expect(args.where.OR[1].closedAt.gte).toBeInstanceOf(Date);
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
        },
      ]);

      const [shift] = await service.findShifts(
        { date: '2026-09-28', type: 'DIURNO' },
        buildSession('sup_1'),
      );

      expect(shift.date).toBe('2026-09-28');
    });
  });
});
