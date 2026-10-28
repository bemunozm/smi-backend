import { Test, TestingModule } from '@nestjs/testing';
import * as webPush from 'web-push';

import { PrismaService } from '../common/prisma/prisma.service';
import { env } from '../common/config/env';
import { PushService } from './push.service';
import type { PushPayload } from './push.service';

jest.mock('web-push');

// `env` se carga en import-time desde `.env`: para controlar las claves VAPID
// por test se mockea el módulo completo con un objeto mutable.
jest.mock('../common/config/env', () => ({
  env: {
    vapidPublicKey: undefined as string | undefined,
    vapidPrivateKey: undefined as string | undefined,
    vapidSubject: 'mailto:test@smi.local',
  },
}));

const sendNotification = webPush.sendNotification as jest.Mock;
const setVapidDetails = webPush.setVapidDetails as jest.Mock;

const mutableEnv = env as {
  vapidPublicKey: string | undefined;
  vapidPrivateKey: string | undefined;
  vapidSubject: string;
};

describe('PushService', () => {
  const findMany = jest.fn();
  const upsert = jest.fn();
  const deleteMany = jest.fn();

  const payload: PushPayload = {
    notificationId: 'n1',
    tipo: 'hallazgo.created',
    titulo: 'Hallazgo de prioridad alta',
    cuerpo: 'detalle',
  };

  // Como `WebPushError` real: un Error con `statusCode` del push service.
  const webPushError = (statusCode: number) =>
    Object.assign(new Error(`push ${statusCode}`), { statusCode });

  const sub = (endpoint: string) => ({
    id: `id-${endpoint}`,
    userId: 'u1',
    endpoint,
    p256dh: 'p256dh-key',
    auth: 'auth-key',
    userAgent: null,
    createdAt: new Date(),
  });

  beforeEach(() => {
    findMany.mockReset();
    upsert.mockReset();
    deleteMany.mockReset();
    sendNotification.mockReset();
    setVapidDetails.mockReset();
    mutableEnv.vapidPublicKey = 'pub-key';
    mutableEnv.vapidPrivateKey = 'priv-key';
    deleteMany.mockResolvedValue({ count: 1 });
    upsert.mockResolvedValue(sub('e'));
  });

  async function makeService(): Promise<PushService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushService,
        {
          provide: PrismaService,
          useValue: { pushSubscription: { findMany, upsert, deleteMany } },
        },
      ],
    }).compile();
    return module.get<PushService>(PushService);
  }

  it('sin claves VAPID: sendToUser no envía ni lanza', async () => {
    mutableEnv.vapidPublicKey = undefined;
    mutableEnv.vapidPrivateKey = undefined;
    const service = await makeService();

    await expect(service.sendToUser('u1', payload)).resolves.toBeUndefined();

    expect(setVapidDetails).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sendToUser envía a TODAS las suscripciones del usuario con el payload JSON', async () => {
    findMany.mockResolvedValue([sub('https://push/a'), sub('https://push/b')]);
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const service = await makeService();

    await service.sendToUser('u1', payload);

    expect(findMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenCalledWith(
      {
        endpoint: 'https://push/a',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      },
      JSON.stringify(payload),
    );
  });

  it('sendToUser trunca cuerpo a 1000 caracteres con "…" antes de serializar', async () => {
    findMany.mockResolvedValue([sub('https://push/a')]);
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const service = await makeService();

    await service.sendToUser('u1', { ...payload, cuerpo: 'x'.repeat(1500) });

    const calls = sendNotification.mock.calls as [unknown, string][];
    const parsed = JSON.parse(calls[0][1]) as { cuerpo: string };
    expect(parsed.cuerpo.length).toBe(1000);
    expect(parsed.cuerpo.endsWith('…')).toBe(true);
  });

  it('un rechazo con statusCode 410 borra ESA suscripción y las demás se envían igual', async () => {
    findMany.mockResolvedValue([
      sub('https://push/muerta'),
      sub('https://push/viva'),
    ]);
    sendNotification.mockImplementation((target: { endpoint: string }) =>
      target.endpoint === 'https://push/muerta'
        ? Promise.reject(webPushError(410))
        : Promise.resolve({ statusCode: 201 }),
    );
    const service = await makeService();

    await service.sendToUser('u1', payload);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { endpoint: 'https://push/muerta' },
    });
  });

  it('un rechazo con statusCode 404 borra la suscripción', async () => {
    findMany.mockResolvedValue([sub('https://push/a')]);
    sendNotification.mockRejectedValue(webPushError(404));
    const service = await makeService();

    await service.sendToUser('u1', payload);

    expect(deleteMany).toHaveBeenCalledWith({
      where: { endpoint: 'https://push/a' },
    });
  });

  it('un rechazo con otro statusCode (403) NO borra la suscripción y no lanza', async () => {
    findMany.mockResolvedValue([sub('https://push/a')]);
    sendNotification.mockRejectedValue(webPushError(403));
    const service = await makeService();

    await expect(service.sendToUser('u1', payload)).resolves.toBeUndefined();

    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('sendToUser nunca rechaza aunque web-push reviente', async () => {
    findMany.mockResolvedValue([sub('https://push/a')]);
    sendNotification.mockImplementation(() => {
      throw new Error('boom');
    });
    const service = await makeService();

    await expect(service.sendToUser('u1', payload)).resolves.toBeUndefined();
  });

  it('saveSubscription hace upsert por endpoint y reasigna userId si ya existía con otro dueño', async () => {
    const service = await makeService();

    await service.saveSubscription('u2', {
      endpoint: 'https://push/a',
      p256dh: 'p',
      auth: 'a',
      userAgent: 'Mozilla/5.0',
    });

    expect(upsert).toHaveBeenCalledWith({
      where: { endpoint: 'https://push/a' },
      update: {
        userId: 'u2',
        p256dh: 'p',
        auth: 'a',
        userAgent: 'Mozilla/5.0',
      },
      create: {
        userId: 'u2',
        endpoint: 'https://push/a',
        p256dh: 'p',
        auth: 'a',
        userAgent: 'Mozilla/5.0',
      },
    });
  });

  it('deleteSubscription borra solo si el endpoint pertenece al usuario, idempotente', async () => {
    deleteMany.mockResolvedValue({ count: 0 });
    const service = await makeService();

    await expect(
      service.deleteSubscription('u1', 'https://push/ajena'),
    ).resolves.toBeUndefined();

    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', endpoint: 'https://push/ajena' },
    });
  });

  it('getPublicKey devuelve la clave de env o null', async () => {
    const service = await makeService();
    expect(service.getPublicKey()).toBe('pub-key');

    mutableEnv.vapidPublicKey = undefined;
    mutableEnv.vapidPrivateKey = undefined;
    const disabled = await makeService();
    expect(disabled.getPublicKey()).toBeNull();
  });
});
