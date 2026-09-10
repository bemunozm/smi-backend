import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrigenMovimiento, TipoMovimiento } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { DOMAIN_EVENTS } from '../common/events/domain-events';
import { SucursalesService } from '../sucursales/sucursales.service';
import { InventarioService } from './inventario.service';

const INSUMO = {
  id: 'ins_1',
  codigo: 'ACE-001',
  nombre: 'Aceite motor 15W-40',
  descripcion: null,
  unidad: 'LITRO',
  tipo: 'SUMINISTRO',
  // Total consolidado de todas las bodegas (RFC-11 §5.2).
  stock: 100,
  stockMinimo: 50,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const PRINCIPAL = {
  id: 'suc_1',
  codigo: 'CENTRAL',
  nombre: 'Casa Matriz',
  direccion: null,
  activa: true,
  esPrincipal: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const NORTE = {
  ...PRINCIPAL,
  id: 'suc_2',
  codigo: 'NORTE',
  esPrincipal: false,
};

describe('InventarioService', () => {
  let service: InventarioService;

  const insumoFindUnique = jest.fn();
  const insumoUpdate = jest.fn();
  const stockUpsert = jest.fn();
  const stockUpdateMany = jest.fn();
  const stockFindUnique = jest.fn();
  const sucursalFindFirst = jest.fn();
  const sucursalFindUnique = jest.fn();
  const movimientoCreate = jest.fn();
  const emit = jest.fn();

  beforeEach(async () => {
    for (const mock of [
      insumoFindUnique,
      insumoUpdate,
      stockUpsert,
      stockUpdateMany,
      stockFindUnique,
      sucursalFindFirst,
      sucursalFindUnique,
      movimientoCreate,
      emit,
    ]) {
      mock.mockReset();
    }

    movimientoCreate.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve(data),
    );
    insumoUpdate.mockResolvedValue(INSUMO);
    // Por defecto, la bodega principal es la que resuelve el service cuando el
    // llamador no indica ninguna.
    sucursalFindFirst.mockResolvedValue(PRINCIPAL);
    sucursalFindUnique.mockResolvedValue(PRINCIPAL);

    const prismaMock = {
      insumo: { findUnique: insumoFindUnique, update: insumoUpdate },
      stockSucursal: {
        upsert: stockUpsert,
        updateMany: stockUpdateMany,
        findUnique: stockFindUnique,
      },
      sucursal: {
        findFirst: sucursalFindFirst,
        findUnique: sucursalFindUnique,
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
        // El service real de sucursales, no un mock: la resolución de la bodega
        // por defecto es parte del contrato que este service promete a
        // Mantenimiento y Terreno, y con un doble no se estaría probando.
        SucursalesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();

    service = module.get<InventarioService>(InventarioService);
  });

  describe('registrarSalida', () => {
    it('descuenta de la bodega y guarda SU saldo en el movimiento', async () => {
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ stock: 70 });

      const movimiento = await service.registrarSalida({
        insumoId: 'ins_1',
        cantidad: 30,
        sucursalId: 'suc_1',
        origen: OrigenMovimiento.INTERVENCION,
        responsableId: 'user_1',
        referenciaId: 'interv_1',
      });

      expect(movimiento).toMatchObject({
        insumoId: 'ins_1',
        sucursalId: 'suc_1',
        tipo: TipoMovimiento.SALIDA,
        origen: OrigenMovimiento.INTERVENCION,
        cantidad: 30,
        // El saldo de LA BODEGA, no el total de la empresa: es el número que el
        // kardex de esa sucursal puede auditar renglón a renglón.
        saldoResultante: 70,
        responsableId: 'user_1',
        referenciaId: 'interv_1',
      });
    });

    it('descuenta con una condición de stock en el propio WHERE, acotada a la bodega', async () => {
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ stock: 90 });

      await service.registrarSalida({
        insumoId: 'ins_1',
        cantidad: 10,
        sucursalId: 'suc_2',
        origen: OrigenMovimiento.ACTIVIDAD,
      });

      // Es la garantía contra dos salidas concurrentes dejando saldo negativo.
      // Repartir el stock en N filas no la puede debilitar: la condición sigue
      // resolviéndose en una sola sentencia sobre la fila de esa bodega.
      expect(stockUpdateMany).toHaveBeenCalledWith({
        where: { insumoId: 'ins_1', sucursalId: 'suc_2', stock: { gte: 10 } },
        data: { stock: { decrement: 10 } },
      });
    });

    it('mantiene el total del insumo sincronizado con la suma de bodegas', async () => {
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ stock: 70 });

      await service.registrarSalida({
        insumoId: 'ins_1',
        cantidad: 30,
        origen: OrigenMovimiento.INTERVENCION,
      });

      // Invariante de RFC-11 §5.2: lo que baja en la bodega baja en el total.
      expect(insumoUpdate).toHaveBeenCalledWith({
        where: { id: 'ins_1' },
        data: { stock: { increment: -30 } },
      });
    });

    it('usa la sucursal principal cuando el llamador no indica ninguna', async () => {
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ stock: 90 });

      // Es exactamente la forma en que Mantenimiento consume stock hoy: sin
      // saber de bodegas. El contrato tiene que seguir funcionando.
      const movimiento = await service.registrarSalida({
        insumoId: 'ins_1',
        cantidad: 10,
        origen: OrigenMovimiento.INTERVENCION,
      });

      expect(sucursalFindFirst).toHaveBeenCalledWith({
        where: { esPrincipal: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(movimiento).toMatchObject({ sucursalId: 'suc_1' });
    });

    it('rechaza mover stock en una sucursal desactivada', async () => {
      sucursalFindUnique.mockResolvedValue({ ...NORTE, activa: false });

      await expect(
        service.registrarSalida({
          insumoId: 'ins_1',
          cantidad: 10,
          sucursalId: 'suc_2',
          origen: OrigenMovimiento.INTERVENCION,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(stockUpdateMany).not.toHaveBeenCalled();
    });

    it('lanza ConflictException y no registra movimiento si el saldo de la bodega no alcanza', async () => {
      stockUpdateMany.mockResolvedValue({ count: 0 });
      insumoFindUnique.mockResolvedValue(INSUMO);
      stockFindUnique.mockResolvedValue({ stock: 5 });

      await expect(
        service.registrarSalida({
          insumoId: 'ins_1',
          cantidad: 30,
          sucursalId: 'suc_1',
          origen: OrigenMovimiento.INTERVENCION,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(movimientoCreate).not.toHaveBeenCalled();
      expect(insumoUpdate).not.toHaveBeenCalled();
    });

    it('avisa cuándo el repuesto sí existe en otra bodega', async () => {
      stockUpdateMany.mockResolvedValue({ count: 0 });
      insumoFindUnique.mockResolvedValue(INSUMO); // total 100
      stockFindUnique.mockResolvedValue({ stock: 5 }); // 5 acá → 95 en otras

      // La diferencia entre "hay que comprar" y "hay que traerlo de Faena
      // Norte" es la decisión completa del bodeguero. Si el error no la
      // distingue, la funcionalidad no sirve de nada.
      await expect(
        service.registrarSalida({
          insumoId: 'ins_1',
          cantidad: 30,
          sucursalId: 'suc_1',
          origen: OrigenMovimiento.INTERVENCION,
        }),
      ).rejects.toThrow(/95 en otras sucursales/);
    });

    it('lanza NotFoundException cuando el insumo no existe', async () => {
      stockUpdateMany.mockResolvedValue({ count: 0 });
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

    it('emite INSUMO_LOW_STOCK cuando el total cruza el mínimo global hacia abajo', async () => {
      // INSUMO: total 100, stockMinimo 50. Salida de 60 → el total queda en 40
      // (<=50). stockAntes se deriva como 40 + 60 = 100, que SÍ estaba por
      // sobre el mínimo: es el cruce.
      //
      // Con el inventario multi-bodega el total ya no sale de una lectura
      // aparte, sino del `update` que sincroniza `Insumo.stock` — por eso el
      // mock que gobierna este test pasó a ser `insumoUpdate`.
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ stock: 15 });
      insumoUpdate.mockResolvedValue({ ...INSUMO, stock: 40 });

      await service.registrarSalida({
        insumoId: 'ins_1',
        cantidad: 60,
        origen: OrigenMovimiento.INTERVENCION,
      });

      expect(emit).toHaveBeenCalledWith(DOMAIN_EVENTS.INSUMO_LOW_STOCK, {
        insumoId: 'ins_1',
        nombre: 'Aceite motor 15W-40',
        stock: 40,
        stockMinimo: 50,
      });
    });

    it('NO reemite INSUMO_LOW_STOCK si el insumo ya estaba bajo el mínimo', async () => {
      // El total queda en 35 (post-decremento) tras esta salida de 10.
      // stockAntes se deriva como 35 + 10 = 45, que YA estaba bajo el mínimo
      // (50): no es un cruce, es "seguir bajando" — no se debe re-emitir
      // (evita spam).
      stockUpdateMany.mockResolvedValue({ count: 1 });
      stockFindUnique.mockResolvedValue({ stock: 5 });
      insumoUpdate.mockResolvedValue({ ...INSUMO, stock: 35 });

      await service.registrarSalida({
        insumoId: 'ins_1',
        cantidad: 10,
        origen: OrigenMovimiento.INTERVENCION,
      });

      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('registrarEntrada', () => {
    it('crea la fila de saldo si la bodega nunca tuvo el insumo, y suma al total', async () => {
      insumoFindUnique.mockResolvedValue(INSUMO);
      stockUpsert.mockResolvedValue({ stock: 50 });

      const movimiento = await service.registrarEntrada({
        insumoId: 'ins_1',
        cantidad: 50,
        sucursalId: 'suc_2',
        origen: OrigenMovimiento.COMPRA,
      });

      // `upsert` y no `update`: la primera vez que un repuesto llega a una
      // bodega no hay fila que actualizar.
      expect(stockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            insumoId_sucursalId: { insumoId: 'ins_1', sucursalId: 'suc_2' },
          },
          create: { insumoId: 'ins_1', sucursalId: 'suc_2', stock: 50 },
          update: { stock: { increment: 50 } },
        }),
      );
      expect(insumoUpdate).toHaveBeenCalledWith({
        where: { id: 'ins_1' },
        data: { stock: { increment: 50 } },
      });
      expect(movimiento).toMatchObject({
        tipo: TipoMovimiento.ENTRADA,
        cantidad: 50,
        saldoResultante: 50,
      });
    });
  });

  describe('ajustarPorConteo', () => {
    it('compara contra el saldo de LA BODEGA, no contra el total', async () => {
      insumoFindUnique.mockResolvedValue(INSUMO); // total 100
      stockFindUnique.mockResolvedValue({ stock: 30 }); // 30 en esta bodega
      stockUpsert.mockResolvedValue({ stock: 45 });

      const movimiento = await service.ajustarPorConteo({
        insumoId: 'ins_1',
        sucursalId: 'suc_1',
        stockContado: 45,
      });

      // Contra el total (100) esto habría sido una SALIDA de 55: el conteo
      // físico de una bodega jamás debe interpretarse como el de la empresa.
      expect(movimiento).toMatchObject({
        tipo: TipoMovimiento.ENTRADA,
        origen: OrigenMovimiento.AJUSTE_FISICO,
        cantidad: 15,
      });
    });

    it('registra una SALIDA cuando el conteo es menor al del sistema', async () => {
      insumoFindUnique.mockResolvedValue(INSUMO);
      stockFindUnique.mockResolvedValue({ stock: 30 });
      stockUpdateMany.mockResolvedValue({ count: 1 });

      const movimiento = await service.ajustarPorConteo({
        insumoId: 'ins_1',
        sucursalId: 'suc_1',
        stockContado: 20,
      });

      expect(movimiento).toMatchObject({
        tipo: TipoMovimiento.SALIDA,
        origen: OrigenMovimiento.AJUSTE_FISICO,
        cantidad: 10,
      });
    });

    it('no registra movimiento si el conteo coincide con el sistema', async () => {
      insumoFindUnique.mockResolvedValue(INSUMO);
      stockFindUnique.mockResolvedValue({ stock: 30 });

      const movimiento = await service.ajustarPorConteo({
        insumoId: 'ins_1',
        sucursalId: 'suc_1',
        stockContado: 30,
      });

      expect(movimiento).toBeNull();
      expect(movimientoCreate).not.toHaveBeenCalled();
    });
  });

  it('reutiliza la transacción del llamador cuando se le pasa un tx', async () => {
    const txStockUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txStockFindUnique = jest.fn().mockResolvedValue({ stock: 90 });
    const txCreate = jest.fn().mockResolvedValue({});
    const tx = {
      insumo: { update: jest.fn().mockResolvedValue(INSUMO) },
      stockSucursal: {
        updateMany: txStockUpdateMany,
        findUnique: txStockFindUnique,
      },
      sucursal: { findFirst: jest.fn().mockResolvedValue(PRINCIPAL) },
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

    // Todo pasó por el tx del llamador — incluida la resolución de la bodega
    // principal. Si algo saliera por fuera, un rollback suyo no lo revertiría.
    expect(txStockUpdateMany).toHaveBeenCalled();
    expect(txCreate).toHaveBeenCalled();
    expect(stockUpdateMany).not.toHaveBeenCalled();
    expect(movimientoCreate).not.toHaveBeenCalled();
  });
});
