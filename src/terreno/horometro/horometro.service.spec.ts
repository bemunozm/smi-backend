import { Test } from '@nestjs/testing';
import { HorometroService } from './horometro.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('HorometroService', () => {
  let service: HorometroService;

  // `create()` y `update()` corren dentro de `$transaction`: las escrituras
  // (y, en `update()`, también la lectura del equipo) deben pasar por el
  // `tx` que recibe el callback, nunca por el cliente `prisma` de nivel
  // superior. Se mockean ambos para poder distinguirlos en los asserts.
  const tx = {
    registroHorometro: {
      create: jest.fn(),
      update: jest.fn(),
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

    // Usado por `create()` (chequeo de existencia previo a la transacción).
    prisma.equipment.findUnique.mockResolvedValue({
      id: 'e1',
      controlUnit: 'HOURS',
      currentHourmeter: 100,
    });

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
    // Usado por `update()` dentro de la transacción: la lectura previa, para
    // poder validar el `valorFinal` nuevo contra su `valorInicial`.
    tx.registroHorometro.findUnique.mockResolvedValue({
      valorInicial: 100,
      equipoId: 'e1',
    });
    // Usado por `update()` dentro de la transacción. Lleva los contadores
    // porque la validación compara contra ellos: el contador no retrocede.
    tx.equipment.findUnique.mockResolvedValue({
      id: 'e1',
      controlUnit: 'HOURS',
      currentHourmeter: 100,
      currentMileage: null,
    });

    prisma.$transaction.mockImplementation(
      (cb: (client: typeof tx) => unknown) => cb(tx),
    );
  });

  describe('create', () => {
    it('al cerrar turno actualiza currentHourmeter del equipo si controla por horas', async () => {
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

    it('sin valorFinal no toca el equipo', async () => {
      await service.create({
        equipoId: 'e1',
        operador: 'Juan Rojas',
        turno: 'NOCTURNO',
        valorInicial: 100,
      });
      expect(tx.equipment.update).not.toHaveBeenCalled();
    });

    it('si el equipo controla por kilometraje actualiza currentMileage (no currentHourmeter)', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: 'e1',
        controlUnit: 'KM',
        // Coherente con la lectura de abajo (100 → 130): el contador de la
        // ficha no puede quedar por delante del final que se está cerrando.
        currentMileage: 100,
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
    });
  });

  /**
   * El contador de la ficha alimenta el motor de mantenimiento preventivo
   * (R6). Si retrocede, una mantención que estaba por vencer vuelve a quedar
   * lejos y el equipo se pasa del umbral sin que nadie se entere — un error
   * que no se ve hasta que rompe algo. Por eso se valida en el servidor y no
   * solo en el formulario: R4 pide registrar sin señal y sincronizar después,
   * y un registro encolado se reenvía sin pasar por la pantalla.
   */
  describe('el contador no retrocede', () => {
    const lectura = {
      equipoId: 'e1',
      operador: 'Juan Rojas',
      turno: 'DIURNO' as const,
      valorInicial: 100,
    };

    it('rechaza el valor final menor que el inicial', async () => {
      await expect(
        service.create({ ...lectura, valorInicial: 5400, valorFinal: 5388 }),
      ).rejects.toThrow(/no puede ser menor que el inicial/);
      expect(tx.registroHorometro.create).not.toHaveBeenCalled();
      expect(tx.equipment.update).not.toHaveBeenCalled();
    });

    it('rechaza el valor final menor que el contador actual del equipo', async () => {
      // El equipo va en 100 h; cerrar en 90 lo haría retroceder.
      await expect(
        service.create({ ...lectura, valorInicial: 80, valorFinal: 90 }),
      ).rejects.toThrow(/no puede retroceder/);
      expect(tx.equipment.update).not.toHaveBeenCalled();
    });

    it('acepta la primera lectura de un equipo sin contador previo', async () => {
      prisma.equipment.findUnique.mockResolvedValue({
        id: 'e1',
        controlUnit: 'HOURS',
        currentHourmeter: null,
      });

      await service.create({ ...lectura, valorInicial: 0, valorFinal: 8 });

      expect(tx.equipment.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { currentHourmeter: 8 },
      });
    });

    it('un turno abierto (sin valor final) no valida ni mueve el contador', async () => {
      await service.create({ ...lectura, valorInicial: 50 });

      expect(tx.registroHorometro.create).toHaveBeenCalled();
      expect(tx.equipment.update).not.toHaveBeenCalled();
    });

    it('al editar tampoco deja retroceder el contador', async () => {
      // La lectura abrió en 80 y el equipo va en 100: cerrar en 90 pasa la
      // regla del inicial pero haría retroceder el contador igual.
      tx.registroHorometro.findUnique.mockResolvedValue({
        valorInicial: 80,
        equipoId: 'e1',
      });

      await expect(service.update('r1', { valorFinal: 90 })).rejects.toThrow(
        /no puede retroceder/,
      );
      expect(tx.registroHorometro.update).not.toHaveBeenCalled();
      expect(tx.equipment.update).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('con controlUnit HOURS escribe currentHourmeter del equipo', async () => {
      tx.equipment.findUnique.mockResolvedValue({
        id: 'e1',
        controlUnit: 'HOURS',
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
  });
});
