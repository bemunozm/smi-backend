import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { SucursalesService } from '../sucursales/sucursales.service';
import { CompatibilidadService } from './compatibilidad.service';

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

const EX_001 = {
  id: 'eq_1',
  codigo: 'EX-001',
  tipo: 'Excavadora',
  marca: 'Caterpillar',
  modelo: '336',
  estado: 'DISPONIBLE',
};

/** Gemelo de EX-001: mismo marca y modelo, sin compatibilidades propias. */
const EX_007 = { ...EX_001, id: 'eq_7', codigo: 'EX-007' };

/** Otra máquina completamente distinta. */
const CM_003 = {
  id: 'eq_3',
  codigo: 'CM-003',
  tipo: 'Camión',
  marca: 'Volvo',
  modelo: 'FMX',
  estado: 'DISPONIBLE',
};

/** Fila de compatibilidad tal como la trae el `include` del service. */
function compatibilidad(over: Record<string, unknown> = {}) {
  return {
    id: 'comp_1',
    nota: null,
    insumo: {
      id: 'ins_1',
      codigo: 'NEU-001',
      nombre: 'Neumático 29.5R25',
      descripcion: null,
      unidad: 'UNIDAD',
      tipo: 'REPUESTO',
      stock: 2,
      stockMinimo: 4,
      stocks: [] as Array<{ stock: number; stockMinimo: number }>,
    },
    ...over,
  };
}

describe('CompatibilidadService', () => {
  let service: CompatibilidadService;

  const equipoFindUnique = jest.fn();
  const equipoFindMany = jest.fn();
  const insumoFindUnique = jest.fn();
  const compatFindMany = jest.fn();
  const compatFindUnique = jest.fn();
  const compatCreate = jest.fn();
  const compatCreateMany = jest.fn();
  const compatDelete = jest.fn();
  const sucursalFindFirst = jest.fn();
  const sucursalFindUnique = jest.fn();

  beforeEach(async () => {
    for (const mock of [
      equipoFindUnique,
      equipoFindMany,
      insumoFindUnique,
      compatFindMany,
      compatFindUnique,
      compatCreate,
      compatCreateMany,
      compatDelete,
      sucursalFindFirst,
      sucursalFindUnique,
    ]) {
      mock.mockReset();
    }
    sucursalFindFirst.mockResolvedValue(CENTRAL);
    sucursalFindUnique.mockResolvedValue(CENTRAL);
    insumoFindUnique.mockResolvedValue({ id: 'ins_1', codigo: 'NEU-001' });

    const prismaMock = {
      equipo: { findUnique: equipoFindUnique, findMany: equipoFindMany },
      insumo: { findUnique: insumoFindUnique },
      compatibilidadEquipoInsumo: {
        findMany: compatFindMany,
        findUnique: compatFindUnique,
        create: compatCreate,
        createMany: compatCreateMany,
        delete: compatDelete,
      },
      sucursal: {
        findFirst: sucursalFindFirst,
        findUnique: sucursalFindUnique,
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompatibilidadService,
        SucursalesService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<CompatibilidadService>(CompatibilidadService);
  });

  describe('repuestosDeEquipo', () => {
    it('cruza cada compatible con el saldo de la bodega, no solo con el total', async () => {
      equipoFindUnique.mockResolvedValue(EX_001);
      // 0 en Casa Matriz, 2 en la empresa: sirve, pero no está acá.
      compatFindMany.mockResolvedValue([
        compatibilidad({
          insumo: {
            ...compatibilidad().insumo,
            stocks: [{ stock: 0, stockMinimo: 1 }],
          },
        }),
      ]);

      const { repuestos } = await service.repuestosDeEquipo('eq_1', {});

      // Saber que "sirve" sin saber si "lo tengo" no cambia ninguna decisión:
      // es el cruce que justifica anclar la relación a ids (RFC-12 §5.3).
      expect(repuestos[0]).toMatchObject({
        codigo: 'NEU-001',
        stockSucursal: 0,
        stockTotal: 2,
        bajoMinimo: true,
      });
    });

    it('alerta solo contra el mínimo propio de la bodega', async () => {
      equipoFindUnique.mockResolvedValue(EX_001);
      compatFindMany.mockResolvedValue([
        compatibilidad({
          insumo: {
            ...compatibilidad().insumo,
            stocks: [{ stock: 8, stockMinimo: 10 }],
          },
        }),
      ]);

      const { repuestos } = await service.repuestosDeEquipo('eq_1', {});

      // Misma regla que la pantalla de stock: comparten `evaluarMinimoBodega`,
      // para que una fila no salga "bajo mínimo" en una vista y "ok" en la otra.
      expect(repuestos[0]).toMatchObject({ stockMinimo: 10, bajoMinimo: true });
    });

    it('filtra a los que tienen saldo cuando se pide', async () => {
      equipoFindUnique.mockResolvedValue(EX_001);
      compatFindMany.mockResolvedValue([
        compatibilidad(),
        compatibilidad({
          id: 'comp_2',
          insumo: {
            ...compatibilidad().insumo,
            id: 'ins_2',
            codigo: 'FIL-001',
            stocks: [{ stock: 12, stockMinimo: 0 }],
          },
        }),
      ]);

      const { repuestos } = await service.repuestosDeEquipo('eq_1', {
        soloConStock: true,
      });

      expect(repuestos).toHaveLength(1);
      expect(repuestos[0].codigo).toBe('FIL-001');
    });

    it('lanza NotFoundException si el equipo no existe', async () => {
      equipoFindUnique.mockResolvedValue(null);
      await expect(
        service.repuestosDeEquipo('nope', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('traduce el choque del @@unique a un 409 que nombra las dos partes', async () => {
      equipoFindUnique.mockResolvedValue(EX_001);
      compatCreate.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      // El `@@unique` es lo que hace idempotente a la replicación; acá se
      // traduce a un mensaje que dice QUÉ ya estaba declarado y en QUÉ máquina,
      // en vez de filtrar un error de Prisma crudo a la pantalla.
      await expect(
        service.create({ equipoId: 'eq_1', insumoId: 'ins_1' }, 'user_1'),
      ).rejects.toThrow(/NEU-001 ya está declarado como compatible con EX-001/);
    });

    it('deja pasar cualquier otro error de la base sin disfrazarlo', async () => {
      equipoFindUnique.mockResolvedValue(EX_001);
      compatCreate.mockRejectedValue(new Error('conexión perdida'));

      // Traducir todo a 409 escondería fallas reales detrás de un mensaje de
      // negocio que no corresponde.
      await expect(
        service.create({ equipoId: 'eq_1', insumoId: 'ins_1' }, 'user_1'),
      ).rejects.toThrow('conexión perdida');
    });
  });

  describe('replicar', () => {
    it('copia las compatibilidades entre equipos del mismo marca y modelo', async () => {
      equipoFindUnique
        .mockResolvedValueOnce(EX_007) // destino
        .mockResolvedValueOnce(EX_001); // origen
      compatFindMany.mockResolvedValue([
        { insumoId: 'ins_1', nota: null },
        { insumoId: 'ins_2', nota: 'Sistema hidráulico' },
      ]);
      compatCreateMany.mockResolvedValue({ count: 2 });

      const resultado = await service.replicar(
        'eq_7',
        { origenId: 'eq_1' },
        'user_1',
      );

      expect(resultado).toEqual({ copiadas: 2, omitidas: 0 });
      // `skipDuplicates`: la acción tiene que poder repetirse sin consecuencias.
      expect(compatCreateMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    it('informa cuántas ya estaban declaradas en vez de fallar', async () => {
      equipoFindUnique
        .mockResolvedValueOnce(EX_007)
        .mockResolvedValueOnce(EX_001);
      compatFindMany.mockResolvedValue([
        { insumoId: 'ins_1', nota: null },
        { insumoId: 'ins_2', nota: null },
      ]);
      compatCreateMany.mockResolvedValue({ count: 1 });

      // Si el destino ya tenía la mitad, se completan las que faltan: obligar a
      // limpiar primero convertiría un atajo en una molestia.
      await expect(
        service.replicar('eq_7', { origenId: 'eq_1' }, 'user_1'),
      ).resolves.toEqual({ copiadas: 1, omitidas: 1 });
    });

    it('rechaza copiar entre máquinas de distinto modelo', async () => {
      equipoFindUnique
        .mockResolvedValueOnce(CM_003)
        .mockResolvedValueOnce(EX_001);

      // Copiar los repuestos de una excavadora a un camión sería propagar
      // información falsa a escala: el atajo no puede saltarse el criterio.
      await expect(
        service.replicar('eq_3', { origenId: 'eq_1' }, 'user_1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(compatCreateMany).not.toHaveBeenCalled();
    });

    it('rechaza replicar desde un origen sin compatibilidades', async () => {
      equipoFindUnique
        .mockResolvedValueOnce(EX_007)
        .mockResolvedValueOnce(EX_001);
      compatFindMany.mockResolvedValue([]);

      await expect(
        service.replicar('eq_7', { origenId: 'eq_1' }, 'user_1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rechaza replicar un equipo sobre sí mismo', async () => {
      equipoFindUnique.mockResolvedValue(EX_001);

      await expect(
        service.replicar('eq_1', { origenId: 'eq_1' }, 'user_1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('origenesReplicables', () => {
    it('sugiere equipos del mismo marca y modelo que ya tienen repuestos', async () => {
      equipoFindUnique.mockResolvedValue(EX_007);
      equipoFindMany.mockResolvedValue([
        { id: 'eq_1', codigo: 'EX-001', _count: { repuestosCompatibles: 5 } },
      ]);

      const origenes = await service.origenesReplicables('eq_7');

      expect(origenes).toEqual([
        { equipoId: 'eq_1', codigo: 'EX-001', cantidad: 5 },
      ]);
      // El match por marca/modelo se usa solo como SUGERENCIA y es
      // case-insensitive: si un typo lo deja sin candidatos, lo peor que pasa
      // es que no aparezca el atajo — no que la máquina quede sin repuestos.
      expect(equipoFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            marca: { equals: 'Caterpillar', mode: 'insensitive' },
            modelo: { equals: '336', mode: 'insensitive' },
          }) as unknown,
        }),
      );
    });
  });

  describe('remove', () => {
    it('lanza NotFoundException si la compatibilidad no existe', async () => {
      compatFindUnique.mockResolvedValue(null);
      await expect(service.remove('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(compatDelete).not.toHaveBeenCalled();
    });
  });
});
