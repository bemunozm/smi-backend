import { Reflector } from '@nestjs/core';

import { ROLES } from '../../auth/roles';
import { HallazgosController } from './hallazgos.controller';

/** Los roles que pide `@Roles` en cada ruta (la metadata que lee el guard). */
const rolesDe = (ruta: keyof HallazgosController) => {
  const handler = Object.getOwnPropertyDescriptor(
    HallazgosController.prototype,
    ruta,
  )?.value as () => unknown;
  return new Reflector().get<string[]>('ROLES', handler);
};

describe('HallazgosController (roles)', () => {
  it('el supervisor temporal registra y corrige hallazgos como el supervisor', () => {
    for (const ruta of ['create', 'update'] as const) {
      expect(rolesDe(ruta)).toEqual(
        expect.arrayContaining([
          ROLES.SUPERVISOR,
          ROLES.SUPERVISOR_TEMPORAL,
          ROLES.ADMIN,
          ROLES.SECRETARIA,
        ]),
      );
    }
  });

  it('eliminar sigue siendo solo del ADMIN', () => {
    expect(rolesDe('remove')).toEqual([ROLES.ADMIN]);
  });

  it('leer hallazgos no pide rol', () => {
    expect(rolesDe('findAll')).toBeUndefined();
    expect(rolesDe('findOne')).toBeUndefined();
  });
});
