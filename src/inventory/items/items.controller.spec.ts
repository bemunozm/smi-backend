import { Reflector } from '@nestjs/core';

import { ROLES } from '../../auth/roles';
import { ItemsController } from './items.controller';

/** Los roles que pide `@Roles` en cada ruta (la metadata que lee el guard). */
const rolesDe = (ruta: keyof ItemsController) => {
  const handler = Object.getOwnPropertyDescriptor(
    ItemsController.prototype,
    ruta,
  )?.value as () => unknown;
  return new Reflector().get<string[]>('ROLES', handler);
};

describe('ItemsController (roles)', () => {
  it('la SECRETARIA crea y edita artículos', () => {
    expect(rolesDe('create')).toEqual([ROLES.ADMIN, ROLES.SECRETARIA]);
    expect(rolesDe('update')).toEqual([ROLES.ADMIN, ROLES.SECRETARIA]);
  });

  it('dar de baja o reactivar es del ADMIN y la SECRETARIA', () => {
    expect(rolesDe('setActive')).toEqual([ROLES.ADMIN, ROLES.SECRETARIA]);
  });

  it('ajustar por conteo y eliminar son solo del ADMIN', () => {
    expect(rolesDe('adjust')).toEqual([ROLES.ADMIN]);
    expect(rolesDe('remove')).toEqual([ROLES.ADMIN]);
  });
});
