import { Reflector } from '@nestjs/core';

import { ROLES } from '../auth/roles';
import { FilesController } from './files.controller';

describe('FilesController (roles)', () => {
  it('la SECRETARIA sube archivos (documentos y fotos de equipos, Report y cargas)', () => {
    const roles = new Reflector().get<string[]>('ROLES', FilesController);
    expect(roles).toEqual(
      expect.arrayContaining([
        ROLES.SUPERVISOR,
        ROLES.ADMIN,
        ROLES.MANTENEDOR,
        ROLES.PREVENCIONISTA,
        ROLES.SECRETARIA,
      ]),
    );
  });
});
