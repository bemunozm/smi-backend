import { BadRequestException } from '@nestjs/common';

import { reconcileEquipmentCounter } from './equipment-counter';

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

      // B6 (auditoría de seguridad): `updateMany` con guarda atómica en el
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

  // B6 de la auditoría de seguridad.
  describe('B6 — guarda atómica contra una reconciliación concurrente', () => {
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
