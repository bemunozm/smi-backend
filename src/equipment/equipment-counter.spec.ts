import { BadRequestException } from '@nestjs/common';

import {
  reconcileEquipmentCounter,
  releaseRemovedReading,
} from './equipment-counter';

describe('reconcileEquipmentCounter', () => {
  const tx = {
    equipment: { updateMany: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    tx.equipment.updateMany.mockResolvedValue({ count: 1 });
  });

  describe("modo 'reject' (Flota)", () => {
    it('mueve currentHourmeter cuando el nuevo valor es mayor o igual al vigente', async () => {
      const result = await reconcileEquipmentCounter(
        tx as never,
        'e1',
        { controlUnit: 'HOURS', currentHourmeter: 100, currentMileage: null },
        130,
        'reject',
      );

      // `updateMany` con guarda atómica en el
      // `where`, no un `update` incondicional — así una reconciliación
      // concurrente nunca puede mover el contador hacia atrás.
      expect(tx.equipment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'e1',
          OR: [{ currentHourmeter: null }, { currentHourmeter: { lt: 130 } }],
        },
        data: { currentHourmeter: 130 },
      });
      expect(result).toEqual({ belowPrevious: false });
    });

    it('mueve currentMileage cuando controlUnit es KM', async () => {
      await reconcileEquipmentCounter(
        tx as never,
        'e1',
        { controlUnit: 'KM', currentHourmeter: null, currentMileage: 5000 },
        5200,
        'reject',
      );

      expect(tx.equipment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'e1',
          OR: [{ currentMileage: null }, { currentMileage: { lt: 5200 } }],
        },
        data: { currentMileage: 5200 },
      });
    });

    it('rechaza con 400 si el nuevo valor es menor que el vigente', async () => {
      await expect(
        reconcileEquipmentCounter(
          tx as never,
          'e1',
          { controlUnit: 'HOURS', currentHourmeter: 500, currentMileage: null },
          130,
          'reject',
        ),
      ).rejects.toThrow(
        'La lectura (130 h) no puede ser menor que el horómetro actual del equipo (500 h)',
      );
      expect(tx.equipment.updateMany).not.toHaveBeenCalled();
    });

    it('rechaza con BadRequestException (no otro tipo de excepción)', async () => {
      await expect(
        reconcileEquipmentCounter(
          tx as never,
          'e1',
          { controlUnit: 'HOURS', currentHourmeter: 500, currentMileage: null },
          130,
          'reject',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('acepta cualquier valor cuando el contador vigente es null', async () => {
      const result = await reconcileEquipmentCounter(
        tx as never,
        'e1',
        { controlUnit: 'HOURS', currentHourmeter: null, currentMileage: null },
        8,
        'reject',
      );

      expect(tx.equipment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'e1',
          OR: [{ currentHourmeter: null }, { currentHourmeter: { lt: 8 } }],
        },
        data: { currentHourmeter: 8 },
      });
      expect(result).toEqual({ belowPrevious: false });
    });

    it("'reject' es el modo por defecto si no se pasa `mode`", async () => {
      await expect(
        reconcileEquipmentCounter(
          tx as never,
          'e1',
          { controlUnit: 'HOURS', currentHourmeter: 500, currentMileage: null },
          130,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("modo 'warn' (apertura de tarjeta de turno)", () => {
    it('NO rechaza y NO mueve el contador si el nuevo valor es menor que el vigente — marca belowPrevious', async () => {
      const result = await reconcileEquipmentCounter(
        tx as never,
        'e1',
        { controlUnit: 'HOURS', currentHourmeter: 500, currentMileage: null },
        130,
        'warn',
      );

      expect(result).toEqual({ belowPrevious: true });
      expect(tx.equipment.updateMany).not.toHaveBeenCalled();
    });

    it('mueve el contador normalmente cuando el nuevo valor NO está por debajo del vigente', async () => {
      const result = await reconcileEquipmentCounter(
        tx as never,
        'e1',
        { controlUnit: 'HOURS', currentHourmeter: 100, currentMileage: null },
        130,
        'warn',
      );

      expect(tx.equipment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'e1',
          OR: [{ currentHourmeter: null }, { currentHourmeter: { lt: 130 } }],
        },
        data: { currentHourmeter: 130 },
      });
      expect(result).toEqual({ belowPrevious: false });
    });

    it('acepta cualquier valor cuando el contador vigente es null', async () => {
      const result = await reconcileEquipmentCounter(
        tx as never,
        'e1',
        { controlUnit: 'KM', currentHourmeter: null, currentMileage: null },
        100,
        'warn',
      );

      expect(result).toEqual({ belowPrevious: false });
      expect(tx.equipment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'e1',
          OR: [{ currentMileage: null }, { currentMileage: { lt: 100 } }],
        },
        data: { currentMileage: 100 },
      });
    });
  });

  describe('guarda atómica contra una reconciliación concurrente', () => {
    it('si `updateMany` no matchea ninguna fila (otra tx ya adelantó el contador), no lanza y devuelve belowPrevious false', async () => {
      // Simula la carrera: el chequeo de arriba vio `vigente=100` (stale),
      // pero para cuando esta escritura corre, otra transacción concurrente
      // ya dejó el contador en 200 (>= 130) — el `where` no matchea, count 0.
      tx.equipment.updateMany.mockResolvedValue({ count: 0 });

      const result = await reconcileEquipmentCounter(
        tx as never,
        'e1',
        { controlUnit: 'HOURS', currentHourmeter: 100, currentMileage: null },
        130,
        'reject',
      );

      expect(result).toEqual({ belowPrevious: false });
    });

    it('el `where` de la escritura SIEMPRE lleva el guard `OR: [null, lt(nuevoValor)]`, nunca un `update` incondicional', async () => {
      await reconcileEquipmentCounter(
        tx as never,
        'e1',
        { controlUnit: 'HOURS', currentHourmeter: null, currentMileage: null },
        250,
        'reject',
      );

      const [args] = tx.equipment.updateMany.mock.calls[0] as [
        { where: { OR: unknown[] } },
      ];
      expect(args.where.OR).toHaveLength(2);
    });
  });
});

describe('reconcileEquipmentCounter: salto imposible (typo)', () => {
  const tx = { equipment: { updateMany: jest.fn() } };
  // El caso del SEM05: horómetro ~2.600 h y una lectura de 4.606 h.
  const SEM05 = {
    controlUnit: 'HOURS' as const,
    currentHourmeter: 2628,
    currentMileage: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    tx.equipment.updateMany.mockResolvedValue({ count: 1 });
  });

  it("modo 'warn': guarda el registro pero NO mueve el contador y lo informa", async () => {
    const result = await reconcileEquipmentCounter(
      tx as never,
      'e5',
      SEM05,
      4606,
      'warn',
    );

    expect(result).toEqual({ belowPrevious: false, implausibleJump: true });
    expect(tx.equipment.updateMany).not.toHaveBeenCalled();
  });

  it("modo 'reject': rechaza con COUNTER_JUMP_IMPLAUSIBLE y un mensaje que explica qué hacer", async () => {
    const error = await reconcileEquipmentCounter(
      tx as never,
      'e5',
      SEM05,
      4606,
      'reject',
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    const respuesta = (error as BadRequestException).getResponse() as {
      code: string;
      message: string;
    };
    expect(respuesta.code).toBe('COUNTER_JUMP_IMPLAUSIBLE');
    expect(respuesta.message).toContain('1.978 h por encima');
    expect(tx.equipment.updateMany).not.toHaveBeenCalled();
  });

  it('un avance normal (hasta 1.000 h) sí mueve el contador', async () => {
    await reconcileEquipmentCounter(tx as never, 'e5', SEM05, 3628, 'warn');

    expect(tx.equipment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentHourmeter: 3628 } }),
    );
  });

  it('sin contador previo (o en 0) la primera lectura lo fija, sea cual sea', async () => {
    for (const vigente of [null, 0]) {
      tx.equipment.updateMany.mockClear();
      await reconcileEquipmentCounter(
        tx as never,
        'e5',
        { ...SEM05, currentHourmeter: vigente },
        4606,
        'warn',
      );
      expect(tx.equipment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { currentHourmeter: 4606 } }),
      );
    }
  });

  it('en km el tope es 20.000 km', async () => {
    const camioneta = {
      controlUnit: 'KM' as const,
      currentHourmeter: null,
      currentMileage: 50000,
    };
    expect(
      await reconcileEquipmentCounter(
        tx as never,
        'c1',
        camioneta,
        69000,
        'warn',
      ),
    ).toEqual({ belowPrevious: false });
    expect(
      await reconcileEquipmentCounter(
        tx as never,
        'c1',
        camioneta,
        71000,
        'warn',
      ),
    ).toEqual({ belowPrevious: false, implausibleJump: true });
  });
});

describe('releaseRemovedReading', () => {
  const tx = {
    equipment: { findUnique: jest.fn(), updateMany: jest.fn() },
    registroHorometro: { aggregate: jest.fn() },
    registroCombustible: { aggregate: jest.fn() },
  };
  const conContador = (currentHourmeter: number | null) =>
    tx.equipment.findUnique.mockResolvedValue({
      controlUnit: 'HOURS',
      currentHourmeter,
      currentMileage: null,
    });
  const quedan = (tarjetas: number | null, carga: number | null = null) => {
    tx.registroHorometro.aggregate.mockResolvedValue({
      _max: { valorInicial: tarjetas, valorFinal: tarjetas },
    });
    tx.registroCombustible.aggregate.mockResolvedValue({
      _max: { lectura: carga },
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    tx.equipment.updateMany.mockResolvedValue({ count: 1 });
  });

  it('el typo que fijó el contador se corrige: el contador vuelve a la lectura más alta que queda', async () => {
    conContador(4606);
    quedan(2628, 2610);

    await releaseRemovedReading(tx as never, 'e5', 4606);

    expect(tx.equipment.updateMany).toHaveBeenCalledWith({
      // Guarda: solo si el contador sigue siendo el que se retiró.
      where: { id: 'e5', currentHourmeter: 4606 },
      data: { currentHourmeter: 2628 },
    });
  });

  it('una carga con lectura más alta que las tarjetas también cuenta', async () => {
    conContador(4606);
    quedan(2600, 2640);

    await releaseRemovedReading(tx as never, 'e5', 4606);

    expect(tx.equipment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentHourmeter: 2640 } }),
    );
  });

  it('si el contador no venía de esa lectura, no se toca', async () => {
    conContador(2700);
    quedan(2628);

    await releaseRemovedReading(tx as never, 'e5', 2650);

    expect(tx.equipment.updateMany).not.toHaveBeenCalled();
  });

  it('sin otras lecturas, o con una igual de alta, no se toca', async () => {
    conContador(4606);
    quedan(null);
    await releaseRemovedReading(tx as never, 'e5', 4606);

    quedan(4606);
    await releaseRemovedReading(tx as never, 'e5', 4606);

    expect(tx.equipment.updateMany).not.toHaveBeenCalled();
  });

  it('sin lectura retirada (carga sin lectura) no consulta nada', async () => {
    await releaseRemovedReading(tx as never, 'e5', null);

    expect(tx.equipment.findUnique).not.toHaveBeenCalled();
  });

  it('en un liviano baja el kilometraje', async () => {
    tx.equipment.findUnique.mockResolvedValue({
      controlUnit: 'KM',
      currentHourmeter: null,
      currentMileage: 950000,
    });
    quedan(95000);

    await releaseRemovedReading(tx as never, 'c1', 950000);

    expect(tx.equipment.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', currentMileage: 950000 },
      data: { currentMileage: 95000 },
    });
  });
});
