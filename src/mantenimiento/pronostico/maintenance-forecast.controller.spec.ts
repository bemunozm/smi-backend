import { Reflector } from '@nestjs/core';

import { ROLES } from '../../auth/roles';
import { MaintenanceForecastController } from './maintenance-forecast.controller';

/** Los roles que pide `@Roles` en cada ruta (la metadata que lee el guard). */
const rolesDe = (ruta: keyof MaintenanceForecastController) =>
  new Reflector().get<string[]>(
    'ROLES',
    MaintenanceForecastController.prototype[ruta],
  );

describe('MaintenanceForecastController (roles)', () => {
  it('la lista de todos los equipos la lee también SECRETARIA (la pizarra muestra la fecha estimada)', () => {
    expect(rolesDe('forAll')).toEqual(
      expect.arrayContaining([
        ROLES.ADMIN,
        ROLES.MANTENEDOR,
        ROLES.SUPERVISOR,
        ROLES.SECRETARIA,
      ]),
    );
  });

  it('el pronóstico de un equipo sigue solo para quienes leen la pauta', () => {
    expect(rolesDe('forEquipment')).toEqual([
      ROLES.ADMIN,
      ROLES.MANTENEDOR,
      ROLES.SUPERVISOR,
    ]);
  });
});
