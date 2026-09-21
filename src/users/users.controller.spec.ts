import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../auth/roles';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Mock mínimo de `UserSession` — solo `user.role` importa para el gate de
 * `findAll`. `as unknown as UserSession` porque el tipo real (de Better
 * Auth) trae muchos más campos de sesión que no son relevantes acá.
 */
function sessionWithRole(role: string): UserSession {
  return {
    user: { id: 'user_1', role },
    session: { id: 'session_1' },
  } as unknown as UserSession;
}

describe('UsersController', () => {
  let controller: UsersController;
  const findAll = jest.fn();
  const findByRole = jest.fn();

  beforeEach(async () => {
    findAll.mockReset();
    findByRole.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: { findAll, findByRole } }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  describe('findAll — directorio completo solo para ADMIN', () => {
    it('rechaza a un SUPERVISOR que no manda ?role (expondría el directorio completo)', async () => {
      await expect(
        controller.findAll({}, sessionWithRole(ROLES.SUPERVISOR)),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(findAll).not.toHaveBeenCalled();
      expect(findByRole).not.toHaveBeenCalled();
    });

    it('permite a un SUPERVISOR con ?role=OPERADOR (alimenta el picker de Flota)', async () => {
      findByRole.mockResolvedValue([]);

      await controller.findAll(
        { role: ROLES.OPERADOR },
        sessionWithRole(ROLES.SUPERVISOR),
      );

      expect(findByRole).toHaveBeenCalledWith(ROLES.OPERADOR);
      expect(findAll).not.toHaveBeenCalled();
    });

    it('permite a un ADMIN listar sin filtro (directorio completo)', async () => {
      findAll.mockResolvedValue([]);

      await controller.findAll({}, sessionWithRole(ROLES.ADMIN));

      expect(findAll).toHaveBeenCalledTimes(1);
      expect(findByRole).not.toHaveBeenCalled();
    });

    it('permite a un ADMIN filtrar con ?role= igual que a un SUPERVISOR', async () => {
      findByRole.mockResolvedValue([]);

      await controller.findAll(
        { role: ROLES.SUPERVISOR },
        sessionWithRole(ROLES.ADMIN),
      );

      expect(findByRole).toHaveBeenCalledWith(ROLES.SUPERVISOR);
      expect(findAll).not.toHaveBeenCalled();
    });
  });
});
