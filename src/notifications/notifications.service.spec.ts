import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { ROLES } from '../auth/roles';
import { PrismaService } from '../common/prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { UsersService } from '../users/users.service';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let service: NotificationsService;

  const findMany = jest.fn();
  const count = jest.fn();
  const updateMany = jest.fn();
  const create = jest.fn();
  const findUniqueUser = jest.fn();
  const sendMail = jest.fn();
  const findByRole = jest.fn();

  beforeEach(async () => {
    findMany.mockReset();
    count.mockReset();
    updateMany.mockReset();
    create.mockReset();
    findUniqueUser.mockReset();
    sendMail.mockReset();
    findByRole.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: PrismaService,
          useValue: {
            notification: { findMany, count, updateMany, create },
            user: { findUnique: findUniqueUser },
          },
        },
        { provide: MailService, useValue: { sendMail } },
        { provide: UsersService, useValue: { findByRole } },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  describe('createForUser', () => {
    it('crea la fila y envía el correo cuando el usuario tiene email resoluble', async () => {
      create.mockResolvedValue({ id: 'n1', userId: 'u1' });
      findUniqueUser.mockResolvedValue({ email: 'u1@smi.local' });

      await service.createForUser('u1', {
        tipo: 'orden.assigned',
        titulo: 'Orden asignada',
        cuerpo: 'detalle',
      });

      expect(create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          tipo: 'orden.assigned',
          titulo: 'Orden asignada',
          cuerpo: 'detalle',
          data: undefined,
        },
      });
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'u1@smi.local',
          subject: 'Orden asignada',
        }),
      );
    });

    it('crea la fila y omite el correo cuando el usuario no tiene email resoluble', async () => {
      create.mockResolvedValue({ id: 'n1', userId: 'u1' });
      findUniqueUser.mockResolvedValue(null);

      await service.createForUser('u1', {
        tipo: 'orden.assigned',
        titulo: 'Orden asignada',
        cuerpo: 'detalle',
      });

      expect(create).toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
    });
  });

  describe('createForRoles', () => {
    it('crea una fila y envía un correo por cada usuario de los roles destino', async () => {
      findByRole.mockImplementation((role: string) => {
        if (role === ROLES.ADMIN) {
          return Promise.resolve([
            { id: 'u1', email: 'admin@smi.local', name: 'Admin' },
          ]);
        }
        if (role === ROLES.SUPERVISOR) {
          return Promise.resolve([
            { id: 'u2', email: 'sup@smi.local', name: 'Supervisor' },
          ]);
        }
        return Promise.resolve([]);
      });
      create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: `n-${data.userId as string}`, ...data }),
      );

      const result = await service.createForRoles(
        [ROLES.ADMIN, ROLES.SUPERVISOR],
        { tipo: 'hallazgo.created', titulo: 'Nuevo hallazgo', cuerpo: 'desc' },
      );

      expect(findByRole).toHaveBeenCalledWith(ROLES.ADMIN);
      expect(findByRole).toHaveBeenCalledWith(ROLES.SUPERVISOR);
      expect(create).toHaveBeenCalledTimes(2);
      expect(sendMail).toHaveBeenCalledTimes(2);
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'admin@smi.local',
          subject: 'Nuevo hallazgo',
        }),
      );
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'sup@smi.local',
          subject: 'Nuevo hallazgo',
        }),
      );
      expect(result).toHaveLength(2);
    });

    it('dedupea destinatarios que aparecen en más de un rol resuelto', async () => {
      findByRole.mockResolvedValue([
        { id: 'u1', email: 'dup@smi.local', name: 'Dup' },
      ]);
      create.mockResolvedValue({ id: 'n-u1' });

      await service.createForRoles([ROLES.ADMIN, ROLES.SUPERVISOR], {
        tipo: 'orden.completed',
        titulo: 'x',
        cuerpo: 'y',
      });

      expect(create).toHaveBeenCalledTimes(1);
      expect(sendMail).toHaveBeenCalledTimes(1);
    });
  });

  describe('markRead', () => {
    it('lanza NotFoundException cuando el userId no coincide con el dueño (ownership)', async () => {
      updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.markRead('otro-usuario', 'notif-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'notif-1', userId: 'otro-usuario' },
        data: { leida: true },
      });
    });

    it('no lanza cuando el usuario es dueño de la notificación', async () => {
      updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.markRead('dueno', 'notif-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('unreadCount', () => {
    it('cuenta solo las notificaciones no leídas del usuario', async () => {
      count.mockResolvedValue(4);

      const result = await service.unreadCount('u1');

      expect(result).toBe(4);
      expect(count).toHaveBeenCalledWith({
        where: { userId: 'u1', leida: false },
      });
    });
  });

  describe('markAllRead', () => {
    it('marca como leídas todas las notificaciones no leídas del usuario', async () => {
      updateMany.mockResolvedValue({ count: 7 });

      await service.markAllRead('u1');

      expect(updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', leida: false },
        data: { leida: true },
      });
    });
  });
});
