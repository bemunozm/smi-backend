import { ForbiddenException } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES, type Role } from '../auth/roles';
import type { CreateIntervencionDto } from './dto/create-intervencion.dto';
import { IntervencionesController } from './intervenciones.controller';
import type { IntervencionesService } from './intervenciones.service';

const sesion = (role: Role) =>
  ({ user: { id: 'u1', role } }) as unknown as UserSession;

const CIERRE = {
  tipo: 'CORRECTIVA',
  detalle: 'Se cambió la manguera',
} as CreateIntervencionDto;

describe('IntervencionesController#create', () => {
  const create = jest.fn().mockResolvedValue({ id: 'i1' });
  const controller = new IntervencionesController({
    create,
  } as unknown as IntervencionesService);

  beforeEach(() => create.mockClear());

  it('SECRETARIA cierra con «qué se hizo», sin insumos', async () => {
    await controller.create('o1', CIERRE, sesion(ROLES.SECRETARIA));
    expect(create).toHaveBeenCalledWith('o1', CIERRE, 'u1');
  });

  it('SECRETARIA no descuenta stock: insumos o bodega -> 403', async () => {
    await expect(
      controller.create(
        'o1',
        { ...CIERRE, insumos: [{ insumoId: 'x', cantidad: 1 }] },
        sesion(ROLES.SECRETARIA),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.create(
        'o1',
        { ...CIERRE, branchId: 'faena' },
        sesion(ROLES.SECRETARIA),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });

  it('el taller sigue registrando insumos', async () => {
    const conInsumos = {
      ...CIERRE,
      branchId: 'faena',
      insumos: [{ insumoId: 'x', cantidad: 1 }],
    };
    await controller.create('o1', conInsumos, sesion(ROLES.MANTENEDOR));
    expect(create).toHaveBeenCalledWith('o1', conInsumos, 'u1');
  });
});
