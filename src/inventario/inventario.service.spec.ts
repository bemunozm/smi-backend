import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { OrigenMovimiento, TipoMovimiento } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { InventarioService } from './inventario.service';

const INSUMO = {
  id: 'ins_1',
  codigo: 'ACE-001',
  nombre: 'Aceite motor 15W-40',
  descripcion: null,
  unidad: 'LITRO',
  stock: 100,
  stockMinimo: 50,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('InventarioService', () => {
  let service: InventarioService;

  const insumoFindUnique = jest.fn();
  const insumoUpdate = jest.fn();
  const insumoUpdateMany = jest.fn();
  const movimientoCreate = jest.fn();

  beforeEach(async () => {
    insumoFindUnique.mockReset();
    insumoUpdate.mockReset();
    insumoUpdateMany.mockReset();
    movimientoCreate.mockReset();
    movimientoCreate.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve(data),
    );

    const prismaMock = {
      insumo: {
        findUnique: insumoFindUnique,
        update: insumoUpdate,
        updateMany: insumoUpdateMany,
      },
      movimientoInventario: { create: movimientoCreate },
      // `ejecutar` abre una transacción cuando el llamador no pasa `tx`: el
      // mock ejecuta el callback con el mismo cliente, que es lo que hace
      // Prisma de verdad salvo por el aislamiento.
      $transaction: (fn: (tx: unknown) => unknown) => fn(prismaMock),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventarioService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<InventarioService>(InventarioService);
  });

  describe('registrarSalida', () => {
    it('descuenta el stock y guarda el saldo resultante en el movimiento', async () => {
      insumoUpdateMany.mockResolvedValue({ count: 1 });
      insumoFindUnique.mockResolvedValue({ ...INSUMO, stock: 70 });

      const movimiento = await service.registrarSalida({
        insumoId: 'ins_1',
        cantidad: 30,
        origen: OrigenMovimiento.INTERVENCION,
        responsableId: 'user_1',
        referenciaId: 'interv_1',
      });

      expect(movimiento).toMatchObject({
        insumoId: 'ins_1',
        tipo: TipoMovimiento.SALIDA,
        origen: OrigenMovimiento.INTERVENCION,
        cantidad: 30,
        saldoResultante: 70,
        responsableId: 'user_1',
        referenciaId: 'interv_1',
      });
    });

    it('descuenta con una condición de stock en el propio WHERE (sin leer-y-escribir)', async () => {
      insumoUpdateMany.mockResolvedValue({ count: 1 });
      insumoFindUnique.mockResolvedValue({ ...INSUMO, stock: 90 });

      await service.registrarSalida({
        insumoId: 'ins_1',
        cantidad: 10,
        origen: OrigenMovimiento.ACTIVIDAD,
      });

      // Es la garantía contra dos salidas concurrentes dejando stock negativo.
      expect(insumoUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ins_1', stock: { gte: 10 } },
        data: { stock: { decrement: 10 } },
      });
    });

    it('lanza ConflictException y no registra movimiento si el stock no alcanza', async () => {
      insumoUpdateMany.mockResolvedValue({ count: 0 });
      insumoFindUnique.mockResolvedValue({ ...INSUMO, stock: 5 });

      await expect(
        service.registrarSalida({
          insumoId: 'ins_1',
          cantidad: 30,
          origen: OrigenMovimiento.INTERVENCION,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(movimientoCreate).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException cuando el insumo no existe', async () => {
      insumoUpdateMany.mockResolvedValue({ count: 0 });
      insumoFindUnique.mockResolvedValue(null);

      await expect(
        service.registrarSalida({
          insumoId: 'missing',
          cantidad: 1,
          origen: OrigenMovimiento.INTERVENCION,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rechaza cantidades no positivas', async () => {
      await expect(
        service.registrarSalida({
          insumoId: 'ins_1',
          cantidad: 0,
          origen: OrigenMovimiento.INTERVENCION,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('registrarEntrada', () => {
    it('suma el stock y registra el movimiento como ENTRADA', async () => {
      insumoFindUnique.mockResolvedValue(INSUMO);
      insumoUpdate.mockResolvedValue({ ...INSUMO, stock: 150 });

      const movimiento = await service.registrarEntrada({
        insumoId: 'ins_1',
        cantidad: 50,
        origen: OrigenMovimiento.COMPRA,
      });

      expect(insumoUpdate).toHaveBeenCalledWith({
        where: { id: 'ins_1' },
        data: { stock: { increment: 50 } },
      });
      expect(movimiento).toMatchObject({
        tipo: TipoMovimiento.ENTRADA,
        cantidad: 50,
        saldoResultante: 150,
      });
    });
  });

  describe('ajustarPorConteo', () => {
    it('registra una ENTRADA cuando el conteo supera al sistema', async () => {
      insumoFindUnique.mockResolvedValue(INSUMO); // stock 100
      insumoUpdate.mockResolvedValue({ ...INSUMO, stock: 115 });

      const movimiento = await service.ajustarPorConteo({
        insumoId: 'ins_1',
        stockContado: 115,
      });

      expect(movimiento).toMatchObject({
        tipo: TipoMovimiento.ENTRADA,
        origen: OrigenMovimiento.AJUSTE_FISICO,
        cantidad: 15,
      });
    });

    it('registra una SALIDA cuando el conteo es menor al sistema', async () => {
      insumoFindUnique.mockResolvedValue(INSUMO); // stock 100
      insumoUpdateMany.mockResolvedValue({ count: 1 });

      const movimiento = await service.ajustarPorConteo({
        insumoId: 'ins_1',
        stockContado: 80,
      });

      expect(movimiento).toMatchObject({
        tipo: TipoMovimiento.SALIDA,
        origen: OrigenMovimiento.AJUSTE_FISICO,
        cantidad: 20,
      });
    });

    it('no registra movimiento si el conteo coincide con el sistema', async () => {
      insumoFindUnique.mockResolvedValue(INSUMO); // stock 100

      const movimiento = await service.ajustarPorConteo({
        insumoId: 'ins_1',
        stockContado: 100,
      });

      expect(movimiento).toBeNull();
      expect(movimientoCreate).not.toHaveBeenCalled();
    });
  });

  it('reutiliza la transacción del llamador cuando se le pasa un tx', async () => {
    const txUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txFindUnique = jest.fn().mockResolvedValue({ ...INSUMO, stock: 90 });
    const txCreate = jest.fn().mockResolvedValue({});
    const tx = {
      insumo: { updateMany: txUpdateMany, findUnique: txFindUnique },
      movimientoInventario: { create: txCreate },
    };

    await service.registrarSalida(
      {
        insumoId: 'ins_1',
        cantidad: 10,
        origen: OrigenMovimiento.INTERVENCION,
      },
      tx as never,
    );

    // Todo pasó por el tx del llamador — si no, el descuento quedaría fuera de
    // su transacción y un rollback suyo no lo revertiría.
    expect(txUpdateMany).toHaveBeenCalled();
    expect(txCreate).toHaveBeenCalled();
    expect(insumoUpdateMany).not.toHaveBeenCalled();
    expect(movimientoCreate).not.toHaveBeenCalled();
  });
});
