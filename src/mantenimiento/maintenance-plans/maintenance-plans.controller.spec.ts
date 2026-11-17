import { Reflector } from '@nestjs/core';

import { ROLES } from '../../auth/roles';
import { MaintenancePlansController } from './maintenance-plans.controller';

/** Los roles que pide `@Roles` en cada ruta (la metadata que lee el guard). */
const rolesDe = (ruta: keyof MaintenancePlansController) => {
  const handler = Object.getOwnPropertyDescriptor(
    MaintenancePlansController.prototype,
    ruta,
  )?.value as () => unknown;
  return new Reflector().get<string[]>('ROLES', handler);
};

describe('MaintenancePlansController (roles)', () => {
  it('corregir el último cambio desde la pizarra es solo del ADMIN', () => {
    expect(rolesDe('correctLastChange')).toEqual([ROLES.ADMIN]);
  });
});
