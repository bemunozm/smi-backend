import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { SucursalesService } from './sucursales.service';

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

const NORTE = {
  ...CENTRAL,
  id: 'suc_2',
  codigo: 'NORTE',
  nombre: 'Faena Norte',
  esPrincipal: false,
};

describe('SucursalesService', () => {
  let service: SucursalesService;

  const findFirst = jest.fn();
  const findUnique = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const updateMany = jest.fn();
  const remove = jest.fn();
  const count = jest.fn();
  const stockCount = jest.fn();

  beforeEach(async () => {
    for (const mock of [
      findFirst,
      findUnique,
      create,
      update,
      updateMany,
      remove,
      count,
      stockCount,
    ]) {
      mock.mockReset();
    }
    updateMany.mockResolvedValue({ count: 0 });
    stockCount.mockResolvedValue(0);

    const prismaMock = {
      sucursal: {
        findFirst,
        findUnique,
        create,
        update,
        updateMany,
        delete: remove,
        count,
      },
      stockSucursal: { count: stockCount },
      $transaction: (fn: (tx: unknown) => unknown) => fn(prismaMock),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SucursalesService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<SucursalesService>(SucursalesService);
  });

  describe('resolverPrincipal', () => {
    it('devuelve la sucursal marcada como principal', async () => {
      findFirst.mockResolvedValue(CENTRAL);
      await expect(service.resolverPrincipal()).resolves.toBe('suc_1');
    });

    it('cae a la más antigua si nadie está marcado, en vez de reventar', async () => {
      // Estado alcanzable solo tocando la BD a mano. Si acá se lanzara, TODOS
      // los movimientos sin sucursal explícita (Mantenimiento, Terreno) se
      // caerían: es peor apagar el inventario que operar sobre una bodega real.
      findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(NORTE);
      await expect(service.resolverPrincipal()).resolves.toBe('suc_2');
    });

    it('lanza si no hay ninguna sucursal registrada', async () => {
      findFirst.mockResolvedValue(null);
      await expect(service.resolverPrincipal()).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('assertOperativa', () => {
    it('rechaza una bodega desactivada', async () => {
      findUnique.mockResolvedValue({ ...NORTE, activa: false });
      await expect(service.assertOperativa('suc_2')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rechaza una bodega inexistente', async () => {
      findUnique.mockResolvedValue(null);
      await expect(service.assertOperativa('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('marca principal a la primera bodega del sistema aunque no lo pidan', async () => {
      count.mockResolvedValue(0);
      create.mockResolvedValue(CENTRAL);

      await service.create({ codigo: 'CENTRAL', nombre: 'Casa Matriz' });

      // Sin principal, el fallback de los movimientos no tendría a dónde ir.
      const [[args]] = create.mock.calls as Array<
        [{ data: { esPrincipal: boolean } }]
      >;
      expect(args.data.esPrincipal).toBe(true);
    });

    it('desmarca la principal anterior al designar una nueva', async () => {
      count.mockResolvedValue(1);
      create.mockResolvedValue(NORTE);

      await service.create({
        codigo: 'NORTE',
        nombre: 'Faena Norte',
        esPrincipal: true,
      });

      expect(updateMany).toHaveBeenCalledWith({
        where: { esPrincipal: true },
        data: { esPrincipal: false },
      });
    });
  });

  describe('update', () => {
    it('impide desactivar la sucursal principal', async () => {
      findUnique.mockResolvedValue(CENTRAL);
      await expect(
        service.update('suc_1', { activa: false }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('impide dejar al sistema sin principal', async () => {
      findUnique.mockResolvedValue(CENTRAL);
      await expect(
        service.update('suc_1', { esPrincipal: false }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('remove', () => {
    it('bloquea la baja de una bodega con kardex', async () => {
      findUnique.mockResolvedValue({
        ...NORTE,
        _count: { movimientos: 12, stocks: 3 },
      });

      // Su historial es parte de la auditoría del inventario: se desactiva, no
      // se borra.
      await expect(service.remove('suc_2')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(remove).not.toHaveBeenCalled();
    });

    it('bloquea la baja de una bodega que todavía tiene saldo', async () => {
      findUnique.mockResolvedValue({
        ...NORTE,
        _count: { movimientos: 0, stocks: 2 },
      });
      stockCount.mockResolvedValue(2);

      await expect(service.remove('suc_2')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(remove).not.toHaveBeenCalled();
    });

    it('elimina una bodega vacía y sin historial', async () => {
      findUnique.mockResolvedValue({
        ...NORTE,
        _count: { movimientos: 0, stocks: 0 },
      });

      await service.remove('suc_2');
      expect(remove).toHaveBeenCalledWith({ where: { id: 'suc_2' } });
    });
  });
});
