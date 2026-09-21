import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { HorometroService } from './horometro.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { SalidaHorometroDto } from './dto/salida-horometro.dto';
import { UpdateHorometroDto } from './dto/update-horometro.dto';

/** Construye un error de Prisma real (no un duck-type) para que el `instanceof`
 * que usa `HorometroService` en la traducción del P2002 lo reconozca (mismo
 * patrón que `equipment.service.spec.ts`). */
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

describe('HorometroService', () => {
  let service: HorometroService;

  // `create()`, `update()` y `salida()` corren dentro de `$transaction`: las
  // lecturas y escrituras deben pasar por el `tx` que recibe el callback,
  // nunca por el cliente `prisma` de nivel superior — incluido el fetch del
  // equipo, que hoy vive DENTRO del `tx` en los tres métodos. Se mockean
  // ambos para poder distinguirlos en los asserts.
  const tx = {
    registroHorometro: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    equipment: { findUnique: jest.fn(), update: jest.fn() },
  };

  const prisma = {
    equipment: { findUnique: jest.fn(), update: jest.fn() },
    registroHorometro: { create: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        HorometroService,
        { provide: PrismaService, useValue: prisma },
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
        ...data,
      }),
    );
    // Usado por los tres métodos (create/salida/update) dentro de la
    // transacción. `currentHourmeter`/`currentMileage` en `null` = sin
    // lectura previa, sin piso para la guarda monotónica (B1) — así los
    // tests que no le apuntan a B1 no se ven afectados por ella.
    tx.equipment.findUnique.mockResolvedValue({
      id: 'e1',
      controlUnit: 'HOURS',
      currentHourmeter: null,
      currentMileage: null,
    });

    prisma.$transaction.mockImplementation(
      (cb: (client: typeof tx) => unknown) => cb(tx),
    );
  });

  describe('create (ENTRADA)', () => {
    it('al mandar valorFinal (flujo de un paso de Terreno) actualiza currentHourmeter con valorFinal', async () => {
      await service.create({
        equipoId: 'e1',
        operador: 'Juan Rojas',
        turno: 'DIURNO',
        valorInicial: 100,
        valorFinal: 130,
        nivelCombustible: 75,
      });
      expect(tx.equipment.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { currentHourmeter: 130 },
      });
    });

    it('sin valorFinal (flujo de dos pasos de Flota) abre el turno y cuadra el contador a valorInicial', async () => {
      await service.create({
        equipoId: 'e1',
        operador: 'Juan Rojas',
        turno: 'NOCTURNO',
        valorInicial: 100,
      });
      expect(tx.equipment.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { currentHourmeter: 100 },
      });
    });

    it('lanza NotFoundException si el equipo no existe', async () => {
      tx.equipment.findUnique.mockResolvedValue(null);

      await expect(
        service.create({
          equipoId: 'missing',
          operador: 'Juan Rojas',
          turno: 'DIURNO',
          valorInicial: 100,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(tx.registroHorometro.create).not.toHaveBeenCalled();
      expect(tx.equipment.update).not.toHaveBeenCalled();
    });

    it('rechaza la entrada si el equipo ya tiene un turno abierto', async () => {
      tx.registroHorometro.findFirst.mockResolvedValue({ id: 'r_abierto' });

      await expect(
        service.create({
          equipoId: 'e1',
          operador: 'Juan Rojas',
          turno: 'DIURNO',
          valorInicial: 100,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.registroHorometro.create).not.toHaveBeenCalled();
      expect(tx.equipment.update).not.toHaveBeenCalled();
    });

    it('el chequeo de turno abierto consulta por equipoId con valorFinal null', async () => {
      await service.create({
        equipoId: 'e1',
        operador: 'Juan Rojas',
        turno: 'DIURNO',
        valorInicial: 100,
      });

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
        service.create({
          equipoId: 'e1',
          operador: 'Juan Rojas',
          turno: 'DIURNO',
          valorInicial: 100,
        }),
      ).rejects.toThrow(
        'El equipo ya tiene un turno en curso; registrá la salida antes de una nueva entrada.',
      );
      expect(tx.equipment.update).not.toHaveBeenCalled();
    });

    it('relanza otros PrismaClientKnownRequestError del create sin traducirlos', async () => {
      tx.registroHorometro.create.mockImplementation(() => {
        throw prismaError('P2003');
      });

      await expect(
        service.create({
          equipoId: 'e1',
          operador: 'Juan Rojas',
          turno: 'DIURNO',
          valorInicial: 100,
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('si el equipo controla por kilometraje actualiza currentMileage (no currentHourmeter)', async () => {
      tx.equipment.findUnique.mockResolvedValue({
        id: 'e1',
        controlUnit: 'KM',
        currentHourmeter: null,
        currentMileage: null,
      });

      await service.create({
        equipoId: 'e1',
        operador: 'Juan Rojas',
        turno: 'DIURNO',
        valorInicial: 100,
        valorFinal: 130,
      });

      expect(tx.equipment.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { currentMileage: 130 },
      });
      expect(tx.equipment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { currentHourmeter: expect.anything() },
        }),
      );
    });

    it('persiste fotoUrl en el registro', async () => {
      await service.create({
        equipoId: 'e1',
        operador: 'Juan Rojas',
        turno: 'DIURNO',
        valorInicial: 100,
        fotoUrl: 'https://example.com/foto.jpg',
      });

      expect(tx.registroHorometro.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fotoUrl: 'https://example.com/foto.jpg',
        }),
      });
    });

    it('sin fotoUrl persiste el registro con fotoUrl null', async () => {
      await service.create({
        equipoId: 'e1',
        operador: 'Juan Rojas',
        turno: 'DIURNO',
        valorInicial: 100,
      });

      expect(tx.registroHorometro.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ fotoUrl: null }),
      });
    });

    it('crea el registro y actualiza el equipo dentro de la misma transacción', async () => {
      await service.create({
        equipoId: 'e1',
        operador: 'Juan Rojas',
        turno: 'DIURNO',
        valorInicial: 100,
        valorFinal: 130,
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.registroHorometro.create).toHaveBeenCalled();
      expect(tx.equipment.update).toHaveBeenCalled();
      // Ninguna escritura debe ocurrir fuera del `tx` de la transacción.
      expect(prisma.registroHorometro.create).not.toHaveBeenCalled();
      expect(prisma.equipment.update).not.toHaveBeenCalled();
      expect(prisma.equipment.findUnique).not.toHaveBeenCalled();
    });

    describe('B1 — el contador del equipo no puede retroceder', () => {
      it('rechaza con 400 si valorFinal es menor que el currentHourmeter vigente', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          controlUnit: 'HOURS',
          currentHourmeter: 500,
          currentMileage: null,
        });

        await expect(
          service.create({
            equipoId: 'e1',
            operador: 'Juan Rojas',
            turno: 'DIURNO',
            valorInicial: 60,
            valorFinal: 65,
          }),
        ).rejects.toThrow(
          'La lectura (65 h) no puede ser menor que el horómetro actual del equipo (500 h)',
        );
        expect(tx.equipment.update).not.toHaveBeenCalled();
      });

      it('rechaza con 400 usando valorInicial (sin valorFinal) cuando es menor que el vigente', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          controlUnit: 'HOURS',
          currentHourmeter: 500,
          currentMileage: null,
        });

        await expect(
          service.create({
            equipoId: 'e1',
            operador: 'Juan Rojas',
            turno: 'DIURNO',
            valorInicial: 60,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(tx.equipment.update).not.toHaveBeenCalled();
      });

      it('acepta cuando el nuevo valor es igual al vigente (no es estrictamente menor)', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          controlUnit: 'HOURS',
          currentHourmeter: 500,
          currentMileage: null,
        });

        await service.create({
          equipoId: 'e1',
          operador: 'Juan Rojas',
          turno: 'DIURNO',
          valorInicial: 500,
          valorFinal: 500,
        });

        expect(tx.equipment.update).toHaveBeenCalledWith({
          where: { id: 'e1' },
          data: { currentHourmeter: 500 },
        });
      });

      it('acepta cualquier valor cuando el contador vigente es null (equipo sin lectura previa)', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          controlUnit: 'HOURS',
          currentHourmeter: null,
          currentMileage: null,
        });

        await service.create({
          equipoId: 'e1',
          operador: 'Juan Rojas',
          turno: 'DIURNO',
          valorInicial: 5,
          valorFinal: 8,
        });

        expect(tx.equipment.update).toHaveBeenCalledWith({
          where: { id: 'e1' },
          data: { currentHourmeter: 8 },
        });
      });

      it('rechaza con 400 si el nuevo valor de currentMileage es menor que el vigente', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          controlUnit: 'KM',
          currentHourmeter: null,
          currentMileage: 5000,
        });

        await expect(
          service.create({
            equipoId: 'e1',
            operador: 'Juan Rojas',
            turno: 'DIURNO',
            valorInicial: 100,
            valorFinal: 130,
          }),
        ).rejects.toThrow(
          'La lectura (130 km) no puede ser menor que el kilometraje actual del equipo (5000 km)',
        );
        expect(tx.equipment.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('salida', () => {
    beforeEach(() => {
      tx.registroHorometro.findUnique.mockResolvedValue({
        id: 'r1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: null,
      });
    });

    it('cierra el turno, cuadra el contador a valorFinal y setea fechaSalida/fotoUrlSalida', async () => {
      await service.salida('r1', {
        valorFinal: 130,
        fotoUrlSalida: 'https://example.com/salida.jpg',
        nivelCombustible: 80,
      });

      expect(tx.registroHorometro.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: {
          valorFinal: 130,
          fotoUrlSalida: 'https://example.com/salida.jpg',
          fechaSalida: expect.any(Date),
          nivelCombustible: 80,
        },
      });
      expect(tx.equipment.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { currentHourmeter: 130 },
      });
    });

    it('sin fotoUrlSalida persiste fotoUrlSalida null', async () => {
      await service.salida('r1', { valorFinal: 130 });

      expect(tx.registroHorometro.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: expect.objectContaining({ fotoUrlSalida: null }),
      });
    });

    it('sin nivelCombustible no lo incluye en el update (no pisa el valor existente)', async () => {
      await service.salida('r1', { valorFinal: 130 });

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

      await service.salida('r1', { valorFinal: 130 });

      expect(tx.equipment.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { currentMileage: 130 },
      });
      expect(tx.equipment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { currentHourmeter: expect.anything() },
        }),
      );
    });

    it('rechaza valorFinal menor que valorInicial', async () => {
      await expect(
        service.salida('r1', { valorFinal: 50 }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.registroHorometro.update).not.toHaveBeenCalled();
      expect(tx.equipment.update).not.toHaveBeenCalled();
    });

    it('rechaza si el turno ya está cerrado', async () => {
      tx.registroHorometro.findUnique.mockResolvedValue({
        id: 'r1',
        equipoId: 'e1',
        valorInicial: 100,
        valorFinal: 120,
      });

      await expect(
        service.salida('r1', { valorFinal: 130 }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(tx.registroHorometro.update).not.toHaveBeenCalled();
      expect(tx.equipment.update).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el registro no existe', async () => {
      tx.registroHorometro.findUnique.mockResolvedValue(null);

      await expect(
        service.salida('missing', { valorFinal: 130 }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(tx.registroHorometro.update).not.toHaveBeenCalled();
    });

    it('cierra el registro y actualiza el equipo dentro de la misma transacción', async () => {
      await service.salida('r1', { valorFinal: 130 });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.registroHorometro.findUnique).toHaveBeenCalled();
      expect(tx.registroHorometro.update).toHaveBeenCalled();
      expect(tx.equipment.findUnique).toHaveBeenCalled();
      expect(tx.equipment.update).toHaveBeenCalled();
      // Ninguna lectura/escritura relevante debe ocurrir fuera del `tx`.
      expect(prisma.registroHorometro.update).not.toHaveBeenCalled();
      expect(prisma.equipment.update).not.toHaveBeenCalled();
    });

    describe('B1 — el contador del equipo no puede retroceder', () => {
      it('rechaza con 400 si valorFinal es menor que el currentHourmeter vigente del equipo', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          controlUnit: 'HOURS',
          currentHourmeter: 500,
          currentMileage: null,
        });

        await expect(
          service.salida('r1', { valorFinal: 130 }),
        ).rejects.toThrow(
          'La lectura (130 h) no puede ser menor que el horómetro actual del equipo (500 h)',
        );
        // El registro alcanzó a cerrarse dentro de la tx (que se revierte
        // en producción); lo que importa acá es que el contador NO se pisa.
        expect(tx.equipment.update).not.toHaveBeenCalled();
      });

      it('acepta cuando valorFinal es igual o mayor al vigente', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          controlUnit: 'HOURS',
          currentHourmeter: 100,
          currentMileage: null,
        });

        await service.salida('r1', { valorFinal: 130 });

        expect(tx.equipment.update).toHaveBeenCalledWith({
          where: { id: 'e1' },
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

        await service.salida('r1', { valorFinal: 130 });

        expect(tx.equipment.update).toHaveBeenCalledWith({
          where: { id: 'e1' },
          data: { currentHourmeter: 130 },
        });
      });
    });
  });

  describe('update', () => {
    it('con controlUnit HOURS escribe currentHourmeter del equipo', async () => {
      tx.equipment.findUnique.mockResolvedValue({
        id: 'e1',
        controlUnit: 'HOURS',
        currentHourmeter: null,
        currentMileage: null,
      });

      await service.update('r1', { valorFinal: 150 });

      expect(tx.registroHorometro.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { valorFinal: 150 },
      });
      expect(tx.equipment.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { currentHourmeter: 150 },
      });
    });

    it('con controlUnit KM actualiza currentMileage (no currentHourmeter)', async () => {
      tx.equipment.findUnique.mockResolvedValue({
        id: 'e1',
        controlUnit: 'KM',
        currentHourmeter: null,
        currentMileage: null,
      });

      await service.update('r1', { valorFinal: 150 });

      expect(tx.equipment.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { currentMileage: 150 },
      });
      expect(tx.equipment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { currentHourmeter: expect.anything() },
        }),
      );
    });

    it('sin valorFinal no consulta ni actualiza el equipo', async () => {
      await service.update('r1', {});

      expect(tx.equipment.findUnique).not.toHaveBeenCalled();
      expect(tx.equipment.update).not.toHaveBeenCalled();
    });

    it('persiste fotoUrl en el registro editado', async () => {
      await service.update('r1', {
        fotoUrl: 'https://example.com/nueva.jpg',
      });

      expect(tx.registroHorometro.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { fotoUrl: 'https://example.com/nueva.jpg' },
      });
    });

    it('actualiza el registro y el equipo dentro de la misma transacción', async () => {
      tx.equipment.findUnique.mockResolvedValue({
        id: 'e1',
        controlUnit: 'HOURS',
        currentHourmeter: null,
        currentMileage: null,
      });

      await service.update('r1', { valorFinal: 150 });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.registroHorometro.update).toHaveBeenCalled();
      expect(tx.equipment.findUnique).toHaveBeenCalled();
      expect(tx.equipment.update).toHaveBeenCalled();
      // Ninguna lectura/escritura relevante debe ocurrir fuera del `tx`.
      expect(prisma.registroHorometro.update).not.toHaveBeenCalled();
      expect(prisma.equipment.findUnique).not.toHaveBeenCalled();
      expect(prisma.equipment.update).not.toHaveBeenCalled();
    });

    describe('B1 — el contador del equipo no puede retroceder', () => {
      it('rechaza con 400 si valorFinal es menor que el currentHourmeter vigente', async () => {
        tx.equipment.findUnique.mockResolvedValue({
          id: 'e1',
          controlUnit: 'HOURS',
          currentHourmeter: 500,
          currentMileage: null,
        });

        await expect(
          service.update('r1', { valorFinal: 130 }),
        ).rejects.toThrow(
          'La lectura (130 h) no puede ser menor que el horómetro actual del equipo (500 h)',
        );
        expect(tx.equipment.update).not.toHaveBeenCalled();
      });
    });
  });
});

// O2 — límites (`@Min`/`@Max`) en los DTOs de horómetro: `nivelCombustible`
// es un porcentaje (0-100), `valorInicial`/`valorFinal` no pueden ser
// negativos. Mismo patrón que `UpdateItemDto` en `items.service.spec.ts`.
describe('CreateHorometroDto — límites', () => {
  const base = {
    equipoId: 'e1',
    operador: 'Juan Rojas',
    turno: 'DIURNO',
    valorInicial: 100,
  };

  it('acepta valores dentro de rango', async () => {
    const dto = plainToInstance(CreateHorometroDto, {
      ...base,
      valorFinal: 130,
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

  it('rechaza valorFinal negativo', async () => {
    const dto = plainToInstance(CreateHorometroDto, {
      ...base,
      valorFinal: -1,
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

describe('UpdateHorometroDto — límites', () => {
  it('acepta valorFinal dentro de rango', async () => {
    const dto = plainToInstance(UpdateHorometroDto, { valorFinal: 130 });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza valorFinal negativo', async () => {
    const dto = plainToInstance(UpdateHorometroDto, { valorFinal: -1 });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
