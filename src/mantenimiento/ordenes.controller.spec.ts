import { ForbiddenException } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES, type Role } from '../auth/roles';
import type { FinalizarOrdenDto } from './dto/finalizar-orden.dto';
import { OrdenesController } from './ordenes.controller';
import type { OrdenesService } from './ordenes.service';

const sesion = (role: Role) =>
  ({ user: { id: 'u1', name: 'Ana', role } }) as unknown as UserSession;

const CIERRE = {
  id: '7f1c2a3b-4d5e-4f60-8a71-9b8c7d6e5f40',
  tipo: 'CORRECTIVA',
  detalle: 'Se cambió la manguera',
  equipmentStatus: 'OPERATIONAL',
} as FinalizarOrdenDto;

describe('OrdenesController#finalizar', () => {
  const finalizar = jest
    .fn()
    .mockResolvedValue({ orden: { id: 'o1' }, intervencion: { id: 'i1' } });
  const controller = new OrdenesController({
    finalizar,
  } as unknown as OrdenesService);

  beforeEach(() => finalizar.mockClear());

  it('pasa el cierre con quien lo firma y responde «Operación finalizada»', async () => {
    const result = await controller.finalizar(
      'o1',
      CIERRE,
      sesion(ROLES.MANTENEDOR),
    );

    expect(finalizar).toHaveBeenCalledWith('o1', CIERRE, {
      id: 'u1',
      name: 'Ana',
    });
    expect(result).toEqual({
      data: { orden: { id: 'o1' }, intervencion: { id: 'i1' } },
      message: 'Operación finalizada',
    });
  });

  it('SECRETARIA finaliza con «qué se hizo», sin insumos', async () => {
    await controller.finalizar('o1', CIERRE, sesion(ROLES.SECRETARIA));
    expect(finalizar).toHaveBeenCalled();
  });

  it('SECRETARIA no descuenta stock: insumos o bodega -> 403', async () => {
    await expect(
      controller.finalizar(
        'o1',
        { ...CIERRE, insumos: [{ insumoId: 'x', cantidad: 1 }] },
        sesion(ROLES.SECRETARIA),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.finalizar(
        'o1',
        { ...CIERRE, branchId: 'faena' },
        sesion(ROLES.SECRETARIA),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(finalizar).not.toHaveBeenCalled();
  });

  it('el taller finaliza con insumos', async () => {
    const conInsumos = {
      ...CIERRE,
      branchId: 'faena',
      insumos: [{ insumoId: 'x', cantidad: 1 }],
    };
    await controller.finalizar('o1', conInsumos, sesion(ROLES.MANTENEDOR));
    expect(finalizar).toHaveBeenCalledWith('o1', conInsumos, {
      id: 'u1',
      name: 'Ana',
    });
  });
});
