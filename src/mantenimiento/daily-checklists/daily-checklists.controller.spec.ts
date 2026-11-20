import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ROLES } from '../../auth/roles';
import {
  DailyChecklistsController,
  MAX_RANGE_DAYS,
} from './daily-checklists.controller';
import type { DailyChecklistsService } from './daily-checklists.service';

/** Los roles que pide `@Roles` en cada ruta (la metadata que lee el guard). */
const rolesDe = (ruta: keyof DailyChecklistsController) =>
  new Reflector().get<string[]>(
    'ROLES',
    // Solo se lee la metadata del método, nunca se invoca.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    DailyChecklistsController.prototype[ruta],
  );

describe('DailyChecklistsController', () => {
  const list = jest.fn().mockResolvedValue([]);
  const controller = new DailyChecklistsController({
    list,
  } as unknown as DailyChecklistsService);

  beforeEach(() => list.mockClear());

  describe('roles', () => {
    it('SECRETARIA solo lee: listado, detalle y catálogo de ítems', () => {
      for (const ruta of ['list', 'findOne', 'items'] as const) {
        expect(rolesDe(ruta)).toEqual(
          expect.arrayContaining([ROLES.ADMIN, ROLES.SECRETARIA]),
        );
      }
    });

    it('enviar, corregir y validar siguen sin SECRETARIA ni ADMIN', () => {
      expect(rolesDe('submit')).toEqual([ROLES.MANTENEDOR]);
      expect(rolesDe('resubmit')).toEqual([ROLES.MANTENEDOR]);
      expect(rolesDe('review')).toEqual([ROLES.SUPERVISOR]);
    });
  });

  describe('GET / (filtros de fecha)', () => {
    it('un día (date) sigue funcionando', async () => {
      await controller.list('2026-11-20');
      expect(list).toHaveBeenCalledWith({
        date: '2026-11-20',
        from: undefined,
        to: undefined,
        equipmentId: undefined,
        status: [],
      });
    });

    it('un rango from–to pasa al servicio junto con los otros filtros', async () => {
      await controller.list(
        undefined,
        '2026-11-01',
        '2026-11-20',
        'eq_1',
        'SUBMITTED,REJECTED',
      );
      expect(list).toHaveBeenCalledWith({
        date: undefined,
        from: '2026-11-01',
        to: '2026-11-20',
        equipmentId: 'eq_1',
        status: ['SUBMITTED', 'REJECTED'],
      });
    });

    it('acepta un rango de exactamente 92 días y de un solo día', async () => {
      await controller.list(undefined, '2026-01-01', '2026-04-02');
      await controller.list(undefined, '2026-11-20', '2026-11-20');
      expect(list).toHaveBeenCalledTimes(2);
    });

    it('rechaza date junto con from/to', async () => {
      await expect(
        controller.list('2026-11-20', '2026-11-01', '2026-11-20'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.list('2026-11-20', '2026-11-01'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(list).not.toHaveBeenCalled();
    });

    it('rechaza un rango incompleto, mal escrito o al revés', async () => {
      for (const [from, to] of [
        ['2026-11-01', undefined],
        [undefined, '2026-11-20'],
        ['2026-13-01', '2026-11-20'],
        ['2026-11-01', 'ayer'],
        ['2026-11-20', '2026-11-01'],
      ] as const) {
        await expect(
          controller.list(undefined, from, to),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(list).not.toHaveBeenCalled();
    });

    it(`rechaza un rango de más de ${MAX_RANGE_DAYS} días`, async () => {
      await expect(
        controller.list(undefined, '2026-01-01', '2026-04-03'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(list).not.toHaveBeenCalled();
    });

    it('sigue rechazando un date inválido y un estado desconocido', async () => {
      await expect(controller.list('2026-02-31')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        controller.list(undefined, undefined, undefined, undefined, 'XX'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
