import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HorometroService } from './horometro.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { buildSession, prismaError } from '../../common/testing/fixtures';
import { OperatorsService } from '../../operators/operators.service';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { SalidaHorometroDto } from './dto/salida-horometro.dto';

/**
 * Captura el `data` de la ÚLTIMA llamada a un mock `jest.fn()` sin tipar.
 * Evitar mezclar `expect.any()`/`expect.anything()`/`expect.objectContaining()`
 * DENTRO de un objeto literal pasado a `toHaveBeenCalledWith` (sobre un mock
 * sin tipar, `tx.*` acá) — eso dispara
 * `@typescript-eslint/no-unsafe-assignment` porque el literal completo queda
 * tipado `any` en ese contexto. Se captura el argumento real y se afirma
 * campo por campo en su lugar.
 */
function lastCallData(mockFn: jest.Mock): Record<string, unknown> {
  const calls = mockFn.mock.calls as unknown as Array<
    [{ data: Record<string, unknown> }]
  >;
  const [{ data }] = calls[calls.length - 1];
  return data;
}

describe('HorometroService', () => {
  let service: HorometroService;

  // `create()` y `salida()` corren dentro de `$transaction`: las lecturas y
  // escrituras deben pasar por el `tx` que recibe el callback, nunca por el
  // cliente `prisma` de nivel superior — incluido el fetch del equipo, que
  // hoy vive DENTRO del `tx` en los dos métodos. Se mockean ambos para poder
  // distinguirlos en los asserts.
  const tx = {
    registroHorometro: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    equipment: { findUnique: jest.fn(), updateMany: jest.fn() },
  };

  const prisma = {
    equipment: { findUnique: jest.fn(), updateMany: jest.fn() },
    registroHorometro: {
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const assertActive = jest.fn();

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        HorometroService,
        { provide: PrismaService, useValue: prisma },
        { provide: OperatorsService, useValue: { assertActive } },
      ],
    }).compile();
    service = mod.get(HorometroService);
    jest.clearAllMocks();

    // Sin turno abierto por defecto — cada test de rechazo lo sobreescribe.
    tx.registroHorometro.findFirst.mockResolvedValue(null);

    tx.registroHorometro.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 'r1',
        ...data,
      }),
    );
    tx.registroHorometro.update.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => ({
        id: where.id,
        equipoId: 'e1',
        shiftId: null,
        ...data,
      }),
    );
    // Usado por los dos métodos (create/salida) dentro de la transacción.
    // `currentHourmeter`/`currentMileage` en `null` = sin lectura previa, sin
    // piso para la guarda monotónica del contador — así los tests que no la
    // ejercitan no se ven afectados por ella. `status: OPERATIONAL` por
    // defecto — los tests de R1 lo sobreescriben.
    tx.equipment.findUnique.mockResolvedValue({
      id: 'e1',
      status: 'OPERATIONAL',
      controlUnit: 'HOURS',
      currentHourmeter: null,
      currentMileage: null,
    });
    // Por defecto la guarda atómica "gana" (count 1) — los tests de la
    // carrera concurrente (ver equipment-counter.spec.ts) sobreescriben esto.
    tx.equipment.updateMany.mockResolvedValue({ count: 1 });

    prisma.$transaction.mockImplementation(
      (cb: (client: typeof tx) => unknown) => cb(tx),
    );

    // Operador del catálogo por defecto — activo (obligatorio, RFC
    // Supervisión en Terreno). Los tests del describe `operatorId
    // (catálogo)` sobreescriben esto.
    assertActive.mockResolvedValue({
      id: 'op_1',
      name: 'Juan Rojas',
      isActive: true,
    });
  });

  describe('create (ENTRADA)', () => {
    const session = buildSession('sup_1');

    it('abre el turno, cuadra el contador a valorInicial y graba supervisorId desde la sesión', async () => {
      await service.create(
        {
          equipoId: 'e1',
          operatorId: 'op_1',
          turno: 'NOCTURNO',
          valorInicial: 100,
        },
        session,
      );

      expect(tx.equipment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'e1',
          OR: [{ currentHourmeter: null }, { currentHourmeter: { lt: 100 } }],
        },
        data: { currentHourmeter: 100 },
      });
      expect(lastCallData(tx.registroHorometro.create).supervisorId).toBe(
        'sup_1',
      );
    });

    it('lanza NotFoundException si el equipo no existe', async () => {
      tx.equipment.findUnique.mockResolvedValue(null);

      await expect(
        service.create(
          {
            equipoId: 'missing',
            operatorId: 'op_1',
            turno: 'DIURNO',
            valorInicial: 100,
          },
          session,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(tx.registroHorometro.create).not.toHaveBeenCalled();
      expect(tx.equipment.updateMany).not.toHaveBeenCalled();
    });

    describe('R1 — el equipo debe estar operativo', () => {
      it('rechaza con 409 EQUIPMENT_NOT_OPERATIONAL si el equipo está en taller', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          status: 'IN_WORKSHOP',
          controlUnit: 'HOURS',
          currentHourmeter: null,
          currentMileage: null,
        });

        expect.assertions(3);
        try {
          await service.create(
            {
              equipoId: 'e1',
              operatorId: 'op_1',
              turno: 'DIURNO',
              valorInicial: 100,
            },
            session,
          );
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(ConflictException);
          expect((error as ConflictException).getResponse()).toMatchObject({
            code: 'EQUIPMENT_NOT_OPERATIONAL',
          });
          expect(tx.registroHorometro.create).not.toHaveBeenCalled();
        }
      });
    });

    it('rechaza la entrada si el equipo ya tiene un turno abierto', async () => {
      tx.registroHorometro.findFirst.mockResolvedValue({ id: 'r_abierto' });

      await expect(
        service.create(
          {
            equipoId: 'e1',
            operatorId: 'op_1',
            turno: 'DIURNO',
            valorInicial: 100,
          },
          session,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.registroHorometro.create).not.toHaveBeenCalled();
      expect(tx.equipment.updateMany).not.toHaveBeenCalled();
    });

    it('el chequeo de turno abierto consulta por equipoId con valorFinal null', async () => {
      await service.create(
        {
          equipoId: 'e1',
          operatorId: 'op_1',
          turno: 'DIURNO',
          valorInicial: 100,
        },
        session,
      );

      expect(tx.registroHorometro.findFirst).toHaveBeenCalledWith({
        where: { equipoId: 'e1', valorFinal: null },
        select: { id: true },
      });
    });

    it('traduce un P2002 del create (carrera del índice único de turno abierto) al mismo BadRequestException del chequeo aplicativo', async () => {
      tx.registroHorometro.create.mockImplementation(() => {
        throw prismaError('P2002', { target: ['equipo_id'] });
      });

      await expect(
        service.create(
          {
            equipoId: 'e1',
            operatorId: 'op_1',
            turno: 'DIURNO',
            valorInicial: 100,
          },
          session,
        ),
      ).rejects.toThrow(
        'El equipo ya tiene un turno en curso; registrá la salida antes de una nueva entrada.',
      );
      expect(tx.equipment.updateMany).not.toHaveBeenCalled();
    });

    it('relanza otros PrismaClientKnownRequestError del create sin traducirlos', async () => {
      tx.registroHorometro.create.mockImplementation(() => {
        throw prismaError('P2003');
      });

      await expect(
        service.create(
          {
            equipoId: 'e1',
            operatorId: 'op_1',
            turno: 'DIURNO',
            valorInicial: 100,
          },
          session,
        ),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('si el equipo controla por kilometraje actualiza currentMileage (no currentHourmeter)', async () => {
      tx.equipment.findUnique.mockResolvedValue({
        id: 'e1',
        status: 'OPERATIONAL',
        controlUnit: 'KM',
        currentHourmeter: null,
        currentMileage: null,
      });

      await service.create(
        {
          equipoId: 'e1',
          operatorId: 'op_1',
          turno: 'DIURNO',
          valorInicial: 100,
        },
        session,
      );

      expect(tx.equipment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'e1',
          OR: [{ currentMileage: null }, { currentMileage: { lt: 100 } }],
        },
        data: { currentMileage: 100 },
      });
      expect(lastCallData(tx.equipment.updateMany)).not.toHaveProperty(
        'currentHourmeter',
      );
    });

    it('crea el registro y actualiza el equipo dentro de la misma transacción', async () => {
      await service.create(
        {
          equipoId: 'e1',
          operatorId: 'op_1',
          turno: 'DIURNO',
          valorInicial: 100,
        },
        session,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.registroHorometro.create).toHaveBeenCalled();
      expect(tx.equipment.updateMany).toHaveBeenCalled();
      // Ninguna escritura debe ocurrir fuera del `tx` de la transacción.
      expect(prisma.registroHorometro.create).not.toHaveBeenCalled();
      expect(prisma.equipment.updateMany).not.toHaveBeenCalled();
      expect(prisma.equipment.findUnique).not.toHaveBeenCalled();
    });

    // `operatorId` es OBLIGATORIO acá (dejó de ser opcional) y `operador`
    // sale del DTO — el snapshot lo arma el SERVIDOR desde el catálogo,
    // nunca desde texto del cliente (mismo patrón único que Trabajos extra).
    describe('operatorId (catálogo)', () => {
      it('valida el operador vía OperatorsService.assertActive y arma el snapshot desde el catálogo', async () => {
        assertActive.mockResolvedValue({
          id: 'op_9',
          name: 'Patricio Rojas',
          isActive: true,
        });

        await service.create(
          {
            equipoId: 'e1',
            operatorId: 'op_9',
            turno: 'DIURNO',
            valorInicial: 100,
          },
          session,
        );

        expect(assertActive).toHaveBeenCalledWith('op_9');
        const data = lastCallData(tx.registroHorometro.create);
        expect(data.operatorId).toBe('op_9');
        // El snapshot viene SIEMPRE del catálogo, nunca de texto que hubiera
        // mandado el cliente — el DTO ni siquiera tiene un campo `operador`.
        expect(data.operador).toBe('Patricio Rojas');
      });

      it('propaga el 404 si el operador no existe, sin abrir la transacción', async () => {
        assertActive.mockRejectedValue(
          new NotFoundException('Operador "op_missing" no encontrado'),
        );

        await expect(
          service.create(
            {
              equipoId: 'e1',
              operatorId: 'op_missing',
              turno: 'DIURNO',
              valorInicial: 100,
            },
            session,
          ),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('propaga el 409 OPERATOR_INACTIVE si el operador existe pero está dado de baja, sin abrir la transacción', async () => {
        assertActive.mockRejectedValue(
          new ConflictException({
            message: 'El operador "Patricio Rojas" está inactivo',
            code: 'OPERATOR_INACTIVE',
          }),
        );

        expect.assertions(3);
        try {
          await service.create(
            {
              equipoId: 'e1',
              operatorId: 'op_1',
              turno: 'DIURNO',
              valorInicial: 100,
            },
            session,
          );
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(ConflictException);
          expect((error as ConflictException).getResponse()).toMatchObject({
            code: 'OPERATOR_INACTIVE',
          });
          expect(prisma.$transaction).not.toHaveBeenCalled();
        }
      });
    });

    describe('el contador del equipo no puede retroceder', () => {
      it('rechaza con 400 si valorInicial es menor que el currentHourmeter vigente', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          status: 'OPERATIONAL',
          controlUnit: 'HOURS',
          currentHourmeter: 500,
          currentMileage: null,
        });

        await expect(
          service.create(
            {
              equipoId: 'e1',
              operatorId: 'op_1',
              turno: 'DIURNO',
              valorInicial: 60,
            },
            session,
          ),
        ).rejects.toThrow(
          'La lectura (60 h) no puede ser menor que el horómetro actual del equipo (500 h)',
        );
        expect(tx.equipment.updateMany).not.toHaveBeenCalled();
      });

      it('acepta cuando el nuevo valor es igual al vigente (no es estrictamente menor)', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          status: 'OPERATIONAL',
          controlUnit: 'HOURS',
          currentHourmeter: 500,
          currentMileage: null,
        });

        await service.create(
          {
            equipoId: 'e1',
            operatorId: 'op_1',
            turno: 'DIURNO',
            valorInicial: 500,
          },
          session,
        );

        expect(tx.equipment.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'e1',
            OR: [{ currentHourmeter: null }, { currentHourmeter: { lt: 500 } }],
          },
          data: { currentHourmeter: 500 },
        });
      });

      it('acepta cualquier valor cuando el contador vigente es null (equipo sin lectura previa)', async () => {
        await service.create(
          {
            equipoId: 'e1',
            operatorId: 'op_1',
            turno: 'DIURNO',
            valorInicial: 8,
          },
          session,
        );

        expect(tx.equipment.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'e1',
            OR: [{ currentHourmeter: null }, { currentHourmeter: { lt: 8 } }],
          },
          data: { currentHourmeter: 8 },
        });
      });

      it('rechaza con 400 si el nuevo valor de currentMileage es menor que el vigente', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          status: 'OPERATIONAL',
          controlUnit: 'KM',
          currentHourmeter: null,
          currentMileage: 5000,
        });

        await expect(
          service.create(
            {
              equipoId: 'e1',
              operatorId: 'op_1',
              turno: 'DIURNO',
              valorInicial: 130,
            },
            session,
          ),
        ).rejects.toThrow(
          'La lectura (130 km) no puede ser menor que el kilometraje actual del equipo (5000 km)',
        );
        expect(tx.equipment.updateMany).not.toHaveBeenCalled();
      });
    });
  });

  describe('salida', () => {
    const session = buildSession('sup_1');

    beforeEach(() => {
      tx.registroHorometro.findUnique.mockResolvedValue({
        id: 'r1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: null,
        shiftId: null,
      });
    });

    it('cierra el turno, cuadra el contador a valorFinal y setea fechaSalida y closedAt', async () => {
      await service.salida(
        'r1',
        { valorFinal: 130, nivelCombustible: 80 },
        session,
      );

      const closeData = lastCallData(tx.registroHorometro.update);
      expect(closeData).toMatchObject({
        valorFinal: 130,
        nivelCombustible: 80,
      });
      expect(closeData.fechaSalida).toBeInstanceOf(Date);
      // Antes NO se seteaba acá — una tarjeta de Supervisión en Terreno
      // cerrada por un ADMIN desde este flujo legacy de Flota nunca entraba
      // a la ventana de "cerradas en las
      // últimas 48h" de `ShiftsService.mine` (filtra por `closedAt`).
      expect(closeData.closedAt).toBeInstanceOf(Date);
      expect(tx.equipment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'e1',
          OR: [{ currentHourmeter: null }, { currentHourmeter: { lt: 130 } }],
        },
        data: { currentHourmeter: 130 },
      });
    });

    it('sin nivelCombustible no lo incluye en el update (no pisa el valor existente)', async () => {
      await service.salida('r1', { valorFinal: 130 }, session);

      const [{ data }] = tx.registroHorometro.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).not.toHaveProperty('nivelCombustible');
    });

    it('si el equipo controla por kilometraje actualiza currentMileage (no currentHourmeter)', async () => {
      tx.equipment.findUnique.mockResolvedValue({
        id: 'e1',
        controlUnit: 'KM',
        currentHourmeter: null,
        currentMileage: null,
      });

      await service.salida('r1', { valorFinal: 130 }, session);

      expect(tx.equipment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'e1',
          OR: [{ currentMileage: null }, { currentMileage: { lt: 130 } }],
        },
        data: { currentMileage: 130 },
      });
      expect(lastCallData(tx.equipment.updateMany)).not.toHaveProperty(
        'currentHourmeter',
      );
    });

    it('rechaza valorFinal menor que valorInicial', async () => {
      await expect(
        service.salida('r1', { valorFinal: 50 }, session),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.registroHorometro.update).not.toHaveBeenCalled();
      expect(tx.equipment.updateMany).not.toHaveBeenCalled();
    });

    it('rechaza si el turno ya está cerrado', async () => {
      tx.registroHorometro.findUnique.mockResolvedValue({
        id: 'r1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: 120,
        shiftId: null,
      });

      await expect(
        service.salida('r1', { valorFinal: 130 }, session),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(tx.registroHorometro.update).not.toHaveBeenCalled();
      expect(tx.equipment.updateMany).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el registro no existe', async () => {
      tx.registroHorometro.findUnique.mockResolvedValue(null);

      await expect(
        service.salida('missing', { valorFinal: 130 }, session),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(tx.registroHorometro.update).not.toHaveBeenCalled();
    });

    it('cierra el registro y actualiza el equipo dentro de la misma transacción', async () => {
      await service.salida('r1', { valorFinal: 130 }, session);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.registroHorometro.findUnique).toHaveBeenCalled();
      expect(tx.registroHorometro.update).toHaveBeenCalled();
      expect(tx.equipment.findUnique).toHaveBeenCalled();
      expect(tx.equipment.updateMany).toHaveBeenCalled();
      // Ninguna lectura/escritura relevante debe ocurrir fuera del `tx`.
      expect(prisma.registroHorometro.update).not.toHaveBeenCalled();
      expect(prisma.equipment.updateMany).not.toHaveBeenCalled();
    });

    describe('SHIFT_CARD_CLOSE_ELSEWHERE — tarjeta de Supervisión en Terreno', () => {
      it('rechaza con 409 si la tarjeta tiene shiftId y quien cierra no es ADMIN', async () => {
        tx.registroHorometro.findUnique.mockResolvedValue({
          id: 'r1',
          equipoId: 'e1',
          valorInicial: 100,
          valorFinal: null,
          shiftId: 'shift_1',
        });

        expect.assertions(3);
        try {
          await service.salida('r1', { valorFinal: 130 }, session);
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(ConflictException);
          expect((error as ConflictException).getResponse()).toMatchObject({
            code: 'SHIFT_CARD_CLOSE_ELSEWHERE',
          });
          expect(tx.registroHorometro.update).not.toHaveBeenCalled();
        }
      });

      it('un ADMIN sí puede cerrar una tarjeta con shiftId desde este endpoint legacy', async () => {
        tx.registroHorometro.findUnique.mockResolvedValue({
          id: 'r1',
          equipoId: 'e1',
          valorInicial: 100,
          valorFinal: null,
          shiftId: 'shift_1',
        });
        const adminSession = buildSession('admin_1', 'ADMIN');

        await service.salida('r1', { valorFinal: 130 }, adminSession);

        const closeData = lastCallData(tx.registroHorometro.update);
        expect(closeData.valorFinal).toBe(130);
        expect(closeData.fechaSalida).toBeInstanceOf(Date);
      });
    });

    describe('el contador del equipo no puede retroceder', () => {
      it('rechaza con 400 si valorFinal es menor que el currentHourmeter vigente del equipo', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          controlUnit: 'HOURS',
          currentHourmeter: 500,
          currentMileage: null,
        });

        await expect(
          service.salida('r1', { valorFinal: 130 }, session),
        ).rejects.toThrow(
          'La lectura (130 h) no puede ser menor que el horómetro actual del equipo (500 h)',
        );
        // El registro alcanzó a cerrarse dentro de la tx (que se revierte
        // en producción); lo que importa acá es que el contador NO se pisa.
        expect(tx.equipment.updateMany).not.toHaveBeenCalled();
      });

      it('acepta cuando valorFinal es igual o mayor al vigente', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          controlUnit: 'HOURS',
          currentHourmeter: 100,
          currentMileage: null,
        });

        await service.salida('r1', { valorFinal: 130 }, session);

        expect(tx.equipment.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'e1',
            OR: [{ currentHourmeter: null }, { currentHourmeter: { lt: 130 } }],
          },
          data: { currentHourmeter: 130 },
        });
      });

      it('acepta cualquier valor cuando el contador vigente es null', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          controlUnit: 'HOURS',
          currentHourmeter: null,
          currentMileage: null,
        });

        await service.salida('r1', { valorFinal: 130 }, session);

        expect(tx.equipment.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'e1',
            OR: [{ currentHourmeter: null }, { currentHourmeter: { lt: 130 } }],
          },
          data: { currentHourmeter: 130 },
        });
      });
    });
  });

  describe('findAll / findOne — sin fugar columnas internas', () => {
    it('findAll omite pumpPhotoKey, closeClientId y clientClockSkewMs', async () => {
      prisma.registroHorometro.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(prisma.registroHorometro.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          omit: {
            pumpPhotoKey: true,
            closeClientId: true,
            clientClockSkewMs: true,
          },
        }),
      );
    });

    it('findOne omite las mismas 3 columnas', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue({ id: 'r1' });

      await service.findOne('r1');

      expect(prisma.registroHorometro.findUnique).toHaveBeenCalledWith({
        where: { id: 'r1' },
        omit: {
          pumpPhotoKey: true,
          closeClientId: true,
          clientClockSkewMs: true,
        },
      });
    });

    it('findOne sigue lanzando 404 si no existe, aun con el omit aplicado', async () => {
      prisma.registroHorometro.findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

// O2 — límites (`@Min`/`@Max`) en los DTOs de horómetro: `nivelCombustible`
// es un porcentaje (0-100), `valorInicial` no puede ser negativo. Mismo
// patrón que `UpdateItemDto` en `items.service.spec.ts`. `operatorId` es
// OBLIGATORIO (RFC Supervisión en Terreno) y `operador` sale del
// DTO — con `forbidNonWhitelisted: true` global, mandarlo es un 400.
describe('CreateHorometroDto — límites', () => {
  const base = {
    equipoId: 'e1',
    operatorId: 'op_1',
    turno: 'DIURNO',
    valorInicial: 100,
  };

  it('acepta valores dentro de rango', async () => {
    const dto = plainToInstance(CreateHorometroDto, {
      ...base,
      nivelCombustible: 75,
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza valorInicial negativo', async () => {
    const dto = plainToInstance(CreateHorometroDto, {
      ...base,
      valorInicial: -1,
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza nivelCombustible fuera de 0-100', async () => {
    const bajoRango = plainToInstance(CreateHorometroDto, {
      ...base,
      nivelCombustible: -1,
    });
    const sobreRango = plainToInstance(CreateHorometroDto, {
      ...base,
      nivelCombustible: 101,
    });
    expect(await validate(bajoRango)).not.toHaveLength(0);
    expect(await validate(sobreRango)).not.toHaveLength(0);
  });

  it('rechaza si falta operatorId', async () => {
    const dto = plainToInstance(CreateHorometroDto, {
      equipoId: base.equipoId,
      turno: base.turno,
      valorInicial: base.valorInicial,
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza operatorId vacío', async () => {
    const dto = plainToInstance(CreateHorometroDto, {
      ...base,
      operatorId: '',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza el body si manda operador — forbidNonWhitelisted lo tumba', async () => {
    const dto = plainToInstance(CreateHorometroDto, {
      ...base,
      operador: 'Juan Rojas',
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rechaza valorFinal — el flujo de un paso se eliminó, forbidNonWhitelisted lo tumba', async () => {
    const dto = plainToInstance(CreateHorometroDto, {
      ...base,
      valorFinal: 130,
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('SalidaHorometroDto — límites', () => {
  it('acepta valores dentro de rango', async () => {
    const dto = plainToInstance(SalidaHorometroDto, {
      valorFinal: 130,
      nivelCombustible: 50,
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza valorFinal negativo', async () => {
    const dto = plainToInstance(SalidaHorometroDto, { valorFinal: -1 });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza nivelCombustible fuera de 0-100', async () => {
    const dto = plainToInstance(SalidaHorometroDto, {
      valorFinal: 130,
      nivelCombustible: 150,
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
