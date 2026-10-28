/**
 * Prueba e2e de las suscripciones Web Push — contra una app Nest real (mismo
 * pipeline que `main.ts`) y Postgres REAL.
 *
 * Cubre el contrato que consume el frontend (`api/PushAPI.ts`): autenticación
 * obligatoria, upsert idempotente por endpoint, reasignación de dueño en
 * dispositivo compartido y borrado con ownership.
 *
 * Se salta completo (`describe.skip`) si Postgres no está arriba.
 */
import { isPostgresReachable } from './helpers/reachability';

const postgresReachable = isPostgresReachable();

import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { env } from '../src/common/config/env';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { bootstrapApp } from './helpers/bootstrap-app';
import {
  loginAgent,
  SEED_PASSWORD,
  SupertestAgent,
} from './helpers/login-agent';

const maybeDescribe = postgresReachable ? describe : describe.skip;

if (!postgresReachable) {
  console.warn(
    'push-subscriptions.e2e-spec: SALTEADO (Postgres no accesible) — ' +
      'levantar con "docker compose up -d"',
  );
}

const ENDPOINT_A = 'https://push.example.test/sub/e2e-a';

function subscriptionBody(endpoint: string) {
  return {
    endpoint,
    keys: { p256dh: 'p256dh-e2e', auth: 'auth-e2e' },
    userAgent: 'e2e-agent',
  };
}

maybeDescribe('Push subscriptions (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let adminAgent: SupertestAgent;
  let supervisorAgent: SupertestAgent;
  let adminId: string;
  let supervisorId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapApp());
    adminAgent = await loginAgent(app, 'admin@smi.local', SEED_PASSWORD);
    supervisorAgent = await loginAgent(
      app,
      'supervisor@smi.local',
      SEED_PASSWORD,
    );
    adminId = (
      await prisma.user.findUniqueOrThrow({
        where: { email: 'admin@smi.local' },
        select: { id: true },
      })
    ).id;
    supervisorId = (
      await prisma.user.findUniqueOrThrow({
        where: { email: 'supervisor@smi.local' },
        select: { id: true },
      })
    ).id;
  });

  beforeEach(async () => {
    await prisma.pushSubscription.deleteMany({
      where: { endpoint: { startsWith: 'https://push.example.test/' } },
    });
  });

  afterAll(async () => {
    await prisma.pushSubscription.deleteMany({
      where: { endpoint: { startsWith: 'https://push.example.test/' } },
    });
    await app.close();
  });

  it('401 sin sesión en los tres endpoints', async () => {
    const anon = request.agent(app.getHttpServer());
    await anon.get('/api/push/vapid-public-key').expect(401);
    await anon
      .post('/api/push/subscriptions')
      .send(subscriptionBody(ENDPOINT_A))
      .expect(401);
    await anon
      .delete('/api/push/subscriptions')
      .send({ endpoint: ENDPOINT_A })
      .expect(401);
  });

  it('GET vapid-public-key devuelve la clave del ambiente, o null cuando no hay claves', async () => {
    // Contra el MISMO env que cargó la app: el `.env` local puede o no traer
    // claves VAPID (son opcionales fuera de producción) y el contrato es
    // "la clave configurada, o null".
    const response = await adminAgent
      .get('/api/push/vapid-public-key')
      .expect(200);
    expect(response.body).toEqual({
      data: { publicKey: env.vapidPublicKey ?? null },
      message: 'ok',
    });
  });

  it('POST crea la fila con el userId de la sesión', async () => {
    await adminAgent
      .post('/api/push/subscriptions')
      .send(subscriptionBody(ENDPOINT_A))
      .expect(201);

    const row = await prisma.pushSubscription.findUniqueOrThrow({
      where: { endpoint: ENDPOINT_A },
    });
    expect(row.userId).toBe(adminId);
    expect(row.p256dh).toBe('p256dh-e2e');
    expect(row.auth).toBe('auth-e2e');
    expect(row.userAgent).toBe('e2e-agent');
  });

  it('POST repetido del mismo endpoint deja UNA fila (upsert)', async () => {
    await adminAgent
      .post('/api/push/subscriptions')
      .send(subscriptionBody(ENDPOINT_A))
      .expect(201);
    await adminAgent
      .post('/api/push/subscriptions')
      .send(subscriptionBody(ENDPOINT_A))
      .expect(201);

    const count = await prisma.pushSubscription.count({
      where: { endpoint: ENDPOINT_A },
    });
    expect(count).toBe(1);
  });

  it('POST del mismo endpoint por OTRO usuario reasigna userId', async () => {
    await adminAgent
      .post('/api/push/subscriptions')
      .send(subscriptionBody(ENDPOINT_A))
      .expect(201);
    await supervisorAgent
      .post('/api/push/subscriptions')
      .send(subscriptionBody(ENDPOINT_A))
      .expect(201);

    const row = await prisma.pushSubscription.findUniqueOrThrow({
      where: { endpoint: ENDPOINT_A },
    });
    expect(row.userId).toBe(supervisorId);
  });

  it('POST con body inválido (sin endpoint o sin keys) → 400', async () => {
    await adminAgent
      .post('/api/push/subscriptions')
      .send({ keys: { p256dh: 'p', auth: 'a' } })
      .expect(400);
    await adminAgent
      .post('/api/push/subscriptions')
      .send({ endpoint: ENDPOINT_A })
      .expect(400);
  });

  it('DELETE borra la fila propia y responde ok', async () => {
    await adminAgent
      .post('/api/push/subscriptions')
      .send(subscriptionBody(ENDPOINT_A))
      .expect(201);

    await adminAgent
      .delete('/api/push/subscriptions')
      .send({ endpoint: ENDPOINT_A })
      .expect(200);

    const count = await prisma.pushSubscription.count({
      where: { endpoint: ENDPOINT_A },
    });
    expect(count).toBe(0);
  });

  it('DELETE de un endpoint ajeno no borra la fila del dueño', async () => {
    await adminAgent
      .post('/api/push/subscriptions')
      .send(subscriptionBody(ENDPOINT_A))
      .expect(201);

    await supervisorAgent
      .delete('/api/push/subscriptions')
      .send({ endpoint: ENDPOINT_A })
      .expect(200);

    const row = await prisma.pushSubscription.findUniqueOrThrow({
      where: { endpoint: ENDPOINT_A },
    });
    expect(row.userId).toBe(adminId);
  });
});
