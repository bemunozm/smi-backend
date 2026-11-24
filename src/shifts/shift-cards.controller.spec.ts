import { Reflector } from '@nestjs/core';

import { ROLES } from '../auth/roles';
import { ShiftCardsController } from './shift-cards.controller';

/** Los roles que pide `@Roles` en cada ruta (la metadata que lee el guard). */
const rolesDe = (ruta: keyof ShiftCardsController) =>
  new Reflector().get<string[]>(
    'ROLES',
    // Solo se lee la metadata del método, nunca se invoca.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    ShiftCardsController.prototype[ruta],
  );

describe('ShiftCardsController (roles)', () => {
  it('PATCH admite a la SECRETARIA (el service la limita a tarjetas temporales)', () => {
    expect(rolesDe('update')).toEqual([
      ROLES.SUPERVISOR,
      ROLES.ADMIN,
      ROLES.SECRETARIA,
    ]);
  });

  it('la SECRETARIA no elimina ni cierra tarjetas', () => {
    expect(rolesDe('remove')).not.toContain(ROLES.SECRETARIA);
    expect(rolesDe('close')).not.toContain(ROLES.SECRETARIA);
  });
});
