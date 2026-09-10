import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../../common/prisma/prisma.service';
import { SucursalesService } from '../../sucursales/sucursales.service';
import { StockService } from './stock.service';

const CENTRAL = {
  id: 'suc_1',
  codigo: 'CENTRAL',
  nombre: 'Casa Matriz',
  direccion: null,
  activa: true,
  esPrincipal: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

/** Insumo tal como lo devuelve el `select` de `StockService`. */
function insumo(over: Record<string, unknown> = {}) {
  return {
    id: 'ins_1',
    codigo: 'NEU-001',
    nombre: 'Neumático 29.5R25',
    descripcion: null,
    unidad: 'UNIDAD',
    tipo: 'REPUESTO',
    stock: 6,
    stockMinimo: 4,
    stocks: [] as Array<{ stock: number; stockMinimo: number }>,
    ...over,
  };
}

describe('StockService', () => {
  let service: StockService;

  const insumoFindMany = jest.fn();
  const insumoFindUnique = jest.fn();
  const sucursalFindMany = jest.fn();
  const sucursalFindUnique = jest.fn();
  const sucursalFindFirst = jest.fn();
  const stockUpsert = jest.fn();

  beforeEach(async () => {
    for (const mock of [
      insumoFindMany,
      insumoFindUnique,
      sucursalFindMany,
      sucursalFindUnique,
      sucursalFindFirst,
      stockUpsert,
    ]) {
      mock.mockReset();
    }
    sucursalFindUnique.mockResolvedValue(CENTRAL);
    sucursalFindFirst.mockResolvedValue(CENTRAL);

    const prismaMock = {
      insumo: { findMany: insumoFindMany, findUnique: insumoFindUnique },
      sucursal: {
        findMany: sucursalFindMany,
        findUnique: sucursalFindUnique,
        findFirst: sucursalFindFirst,
      },
      stockSucursal: { upsert: stockUpsert },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StockService,
        SucursalesService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<StockService>(StockService);
  });

  describe('listar', () => {
    it('muestra saldo 0 para un insumo que la bodega nunca ha manejado', async () => {
      insumoFindMany.mockResolvedValue([insumo({ stocks: [] })]);

      const { items } = await service.listar({ sucursalId: 'suc_1' });

      // No es un error ni una omisión: "existe en la empresa pero NO acá" es
      // exactamente la información que motiva PROD-11.
      expect(items[0]).toMatchObject({
        stock: 0,
        stockTotal: 6,
        enBodega: false,
      });
    });

    it('NO alerta cuando la bodega no fijó un mínimo propio', async () => {
      insumoFindMany.mockResolvedValue([
        insumo({ stocks: [{ stock: 3, stockMinimo: 0 }] }),
      ]);

      const { items } = await service.listar({ sucursalId: 'suc_1' });

      // El mínimo global (4) es de la EMPRESA y está calibrado sobre el total.
      // Heredarlo como umbral de bodega marcaba los 10 de 10 ítems como bajo
      // mínimo: una alerta que se enciende siempre enseña a ignorar la pantalla.
      // Un umbral que nadie configuró no se puede cruzar.
      expect(items[0]).toMatchObject({ stockMinimo: 0, bajoMinimo: false });
    });

    it('respeta el mínimo propio de la bodega cuando lo tiene', async () => {
      insumoFindMany.mockResolvedValue([
        insumo({ stocks: [{ stock: 8, stockMinimo: 10 }] }),
      ]);

      const { items } = await service.listar({ sucursalId: 'suc_1' });

      expect(items[0]).toMatchObject({ stockMinimo: 10, bajoMinimo: true });
    });

    it('filtra a los ítems bajo mínimo cuando se pide', async () => {
      insumoFindMany.mockResolvedValue([
        insumo({ stocks: [{ stock: 30, stockMinimo: 5 }] }),
        insumo({
          id: 'ins_2',
          codigo: 'BAT-001',
          stocks: [{ stock: 1, stockMinimo: 2 }],
        }),
      ]);

      const { items } = await service.listar({
        sucursalId: 'suc_1',
        bajoStock: true,
      });

      expect(items).toHaveLength(1);
      expect(items[0].codigo).toBe('BAT-001');
    });

    it('cae a la sucursal principal si no se indica ninguna', async () => {
      insumoFindMany.mockResolvedValue([]);

      const { sucursalId } = await service.listar({});

      // Entrar a la pantalla sin haber elegido bodega debe mostrar algo útil.
      expect(sucursalId).toBe('suc_1');
      expect(sucursalFindFirst).toHaveBeenCalled();
    });
  });

  describe('desglosePorSucursal', () => {
    it('incluye las bodegas sin existencia, con saldo 0', async () => {
      insumoFindUnique.mockResolvedValue(insumo());
      sucursalFindMany.mockResolvedValue([
        { id: 'suc_1', codigo: 'CENTRAL', nombre: 'Casa Matriz', stocks: [] },
        {
          id: 'suc_2',
          codigo: 'NORTE',
          nombre: 'Faena Norte',
          stocks: [{ stock: 6, stockMinimo: 0 }],
        },
      ]);

      const desglose = await service.desglosePorSucursal('ins_1');

      // Si se listaran solo las filas de stock, "no hay en ninguna parte" sería
      // indistinguible de "esa bodega no la consulté".
      expect(desglose.sucursales).toHaveLength(2);
      expect(desglose.sucursales[0]).toMatchObject({
        sucursalCodigo: 'CENTRAL',
        stock: 0,
        // Sin fila de stock no hay umbral configurado: aparece en el desglose
        // con saldo 0, pero no como alerta de esa bodega.
        bajoMinimo: false,
      });
      expect(desglose.sucursales[1]).toMatchObject({
        sucursalCodigo: 'NORTE',
        stock: 6,
        bajoMinimo: false,
      });
    });
  });
});
