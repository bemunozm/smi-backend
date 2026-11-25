import { Reflector } from '@nestjs/core';

import { ROLES } from '../../auth/roles';
import { InformesTemporalesController } from './informes-temporales.controller';

/** Los roles que pide `@Roles` en cada ruta (la metadata que lee el guard). */
const rolesDe = (ruta: keyof InformesTemporalesController) => {
  const handler = Object.getOwnPropertyDescriptor(
    InformesTemporalesController.prototype,
    ruta,
  )?.value as () => unknown;
  return new Reflector().get<string[]>('ROLES', handler);
};

/** Las rutas GET en el orden en que Nest las registra. */
const rutasGet = () =>
  Object.getOwnPropertyNames(InformesTemporalesController.prototype)
    .map((nombre) => {
      const handler = Object.getOwnPropertyDescriptor(
        InformesTemporalesController.prototype,
        nombre,
      )?.value as unknown;
      if (typeof handler !== 'function') return null;
      const method = Reflect.getMetadata('method', handler) as
        number | undefined;
      const path = Reflect.getMetadata('path', handler) as string | undefined;
      return method === 0 ? path : null; // RequestMethod.GET
    })
    .filter((p): p is string => p != null);

describe('InformesTemporalesController (roles)', () => {
  it('«Mis reportes» es solo del supervisor temporal', () => {
    expect(rolesDe('findMine')).toEqual([ROLES.SUPERVISOR_TEMPORAL]);
  });

  it('`mine` se declara antes de `:id` para que no se lea como un id', () => {
    const rutas = rutasGet();
    expect(rutas.indexOf('mine')).toBeGreaterThanOrEqual(0);
    expect(rutas.indexOf('mine')).toBeLessThan(rutas.indexOf(':id'));
  });

  it('el detalle lo ve el supervisor temporal (el servicio lo limita a los suyos)', () => {
    expect(rolesDe('findOne')).toEqual([
      ROLES.ADMIN,
      ROLES.SECRETARIA,
      ROLES.SUPERVISOR_TEMPORAL,
    ]);
  });

  it('el listado completo, corregir y eliminar no son del supervisor temporal', () => {
    expect(rolesDe('findAll')).not.toContain(ROLES.SUPERVISOR_TEMPORAL);
    expect(rolesDe('update')).not.toContain(ROLES.SUPERVISOR_TEMPORAL);
    expect(rolesDe('remove')).toEqual([ROLES.ADMIN]);
  });
});
