/**
 * Gate e2e de Hallazgos — idempotencia del alta para el reenvío offline:
 * `POST /api/hallazgos` con `id` del cliente contra una app Nest real (mismo
 * pipeline que `main.ts`, vía `configureApp`), Postgres y MinIO REALES.
 *
 * Cubre lo que un reintento no debe repetir (segunda notificación, segundo
 * claim de la foto) y lo que no debe permitir (pisar la fila de otro usuario).
 *
 * Equipos y usuarios: SIEMPRE frescos por el test, para que un rerun no choque
 * con estado de una corrida anterior.
 *
 * Se salta completo (`describe.skip`) si MinIO o Postgres no están arriba.
 */
import { randomUUID } from 'node:crypto';

import { isMinioReachable, isPostgresReachable } from './helpers/reachability';

const minioReachable = isMinioReachable();
const postgresReachable = isPostgresReachable();

const TEST_BUCKET = 'smi-hallazgos-e2e';
// IMPORTANTE: `env.ts` lee `process.env.STORAGE_BUCKET` en IMPORT-TIME — esta
// asignación debe correr ANTES del primer `import` real de `AppModule`/`env`
// (ver la cabecera de `files-storage.e2e-spec.ts`).
process.env.STORAGE_BUCKET = TEST_BUCKET;

import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

import { ROLES } from '../src/auth/roles';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  DEFAULT_DEV_STORAGE_ACCESS_KEY_ID,
  DEFAULT_DEV_STORAGE_SECRET_ACCESS_KEY,
} from '../src/common/config/env';
import { ApiEnvelope, ErrorEnvelope } from './helpers/api-envelope';
import { bootstrapApp } from './helpers/bootstrap-app';
import {
  baseEquipmentPayload,
  EquipmentData,
} from './helpers/equipment-fixtures';
import {
  loginAgent,
  SEED_PASSWORD,
  SupertestAgent,
} from './helpers/login-agent';

const maybeDescribe =
  minioReachable && postgresReachable ? describe : describe.skip;

if (!minioReachable || !postgresReachable) {
  console.warn(
    `hallazgos.e2e-spec: SALTEADO (MinIO reachable=${minioReachable}, ` +
      `Postgres reachable=${postgresReachable}) — levantar con ` +
      '"docker compose up -d minio minio-init smi-postgres"',
  );
}

const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
]);

interface UploadFileData {
  key: string;
  url: string;
}
interface UserData {
  id: string;
  email: string;
  [key: string]: unknown;
}
interface HallazgoData {
  id: string;
  equipoId: string;
  descripcion: string;
  prioridad: string;
  estado: string;
  fotoUrl: string | null;
  fecha: string;
  [key: string]: unknown;
}

async function ensureBucketExists(
  client: S3Client,
  bucket: string,
): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

async function deleteAllObjects(
  client: S3Client,
  bucket: string,
): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of listed.Contents ?? []) {
      if (object.Key) {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }),
        );
      }
    }
    continuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined;
  } while (continuationToken);
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  description: string,
  timeoutMs = 5000,
  intervalMs = 150,
): Promise<T> {
  const start = Date.now();
  let last: T | null | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor: tiempo de espera agotado (${description})`);
}

maybeDescribe('Hallazgos — alta idempotente (e2e)', () => {
  jest.setTimeout(30_000);

  let app: NestExpressApplication;
  let prisma: PrismaService;
  let rawS3: S3Client;

  let adminAgent: SupertestAgent;
  let supervisorAgent: SupertestAgent;
  let supervisorBAgent: SupertestAgent;
  let mantenedorAgent: SupertestAgent;

  let adminUserId: string;
  let supervisorBUserId: string;
  let equipo: EquipmentData;

  // `internalCode` tiene @MaxLength(20) — "HZ-" (3) + RUN_ID (5) + "-" (1).
  const RUN_ID = randomUUID().slice(0, 5);
  const createdHallazgoIds: string[] = [];

  function hallazgoPayload(overrides: Record<string, unknown> = {}) {
    return {
      id: randomUUID(),
      equipoId: equipo.id,
      descripcion: `Fuga de aceite (e2e ${RUN_ID})`,
      prioridad: 'ALTA',
      ...overrides,
    };
  }

  async function uploadPhoto(agent: SupertestAgent): Promise<UploadFileData> {
    const response = await agent
      .post('/api/files')
      .attach('file', MINIMAL_JPEG, 'hallazgo.jpg')
      .expect(201);
    return (response.body as ApiEnvelope<UploadFileData>).data;
  }

  async function countAdminNotifications(hallazgoId: string): Promise<number> {
    return prisma.notification.count({
      where: {
        userId: adminUserId,
        data: { path: ['hallazgoId'], equals: hallazgoId },
      },
    });
  }

  beforeAll(async () => {
    rawS3 = new S3Client({
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: DEFAULT_DEV_STORAGE_ACCESS_KEY_ID,
        secretAccessKey: DEFAULT_DEV_STORAGE_SECRET_ACCESS_KEY,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    await ensureBucketExists(rawS3, TEST_BUCKET);

    ({ app, prisma } = await bootstrapApp());

    adminAgent = await loginAgent(app, 'admin@smi.local', SEED_PASSWORD);
    supervisorAgent = await loginAgent(
      app,
      'supervisor@smi.local',
      SEED_PASSWORD,
    );
    mantenedorAgent = await loginAgent(
      app,
      'mantenedor@smi.local',
      SEED_PASSWORD,
    );

    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { email: 'admin@smi.local' },
      select: { id: true },
    });
    adminUserId = adminUser.id;

    const createUserResponse = await adminAgent
      .post('/api/users')
      .send({
        name: 'Supervisor B (e2e hallazgos)',
        email: `supervisor-b-hz-${RUN_ID}@e2e.smi.local`,
        password: SEED_PASSWORD,
        role: ROLES.SUPERVISOR,
      })
      .expect(201);
    const supervisorB = (createUserResponse.body as ApiEnvelope<UserData>).data;
    supervisorBUserId = supervisorB.id;
    supervisorBAgent = await loginAgent(app, supervisorB.email, SEED_PASSWORD);

    const equipoResponse = await adminAgent
      .post('/api/equipment')
      .send(baseEquipmentPayload(`HZ-${RUN_ID}-1`))
      .expect(201);
    equipo = (equipoResponse.body as ApiEnvelope<EquipmentData>).data;
  });

  afterAll(async () => {
    if (createdHallazgoIds.length > 0) {
      await prisma.notification.deleteMany({
        where: {
          OR: createdHallazgoIds.map((id) => ({
            data: { path: ['hallazgoId'], equals: id },
          })),
        },
      });
      await prisma.hallazgo.deleteMany({
        where: { id: { in: createdHallazgoIds } },
      });
    }
    if (equipo) {
      await prisma.equipment.deleteMany({ where: { id: equipo.id } });
    }
    if (supervisorBUserId) {
      await adminAgent.delete(`/api/users/${supervisorBUserId}`).expect(200);
    }

    await deleteAllObjects(rawS3, TEST_BUCKET);
    await app.close();
  });

  it('crea con foto e id del cliente -> 201, con la foto firmada y sin exponer la key', async () => {
    const upload = await uploadPhoto(supervisorAgent);
    const payload = hallazgoPayload({ fotoKey: upload.key });
    createdHallazgoIds.push(payload.id);

    const response = await supervisorAgent
      .post('/api/hallazgos')
      .send(payload)
      .expect(201);

    const data = (response.body as ApiEnvelope<HallazgoData>).data;
    expect(data.id).toBe(payload.id);
    expect(data.estado).toBe('ABIERTO');
    expect(data.fotoUrl).toEqual(expect.stringContaining('http'));
    expect('fotoKey' in data).toBe(false);
  });

  it('el reintento con el mismo id devuelve la misma fila y notifica UNA sola vez', async () => {
    const upload = await uploadPhoto(supervisorAgent);
    const payload = hallazgoPayload({ fotoKey: upload.key });
    createdHallazgoIds.push(payload.id);

    const first = await supervisorAgent
      .post('/api/hallazgos')
      .send(payload)
      .expect(201);
    const firstData = (first.body as ApiEnvelope<HallazgoData>).data;

    await waitFor(
      async () =>
        (await countAdminNotifications(payload.id)) > 0 ? true : null,
      'notificación ADMIN del hallazgo',
    );
    expect(await countAdminNotifications(payload.id)).toBe(1);

    // La key tmp ya se consumió en el primer envío: el reintento no puede
    // reclamarla de nuevo, y aun así debe responder igual.
    const replay = await supervisorAgent
      .post('/api/hallazgos')
      .send(payload)
      .expect(201);
    const replayData = (replay.body as ApiEnvelope<HallazgoData>).data;

    expect(replayData.id).toBe(firstData.id);
    expect(replayData.descripcion).toBe(firstData.descripcion);
    expect(replayData.fotoUrl).toEqual(expect.stringContaining('http'));

    // El listener corre fire-and-forget: se da margen antes de afirmar que
    // NO apareció una segunda notificación.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await countAdminNotifications(payload.id)).toBe(1);
    expect(await prisma.hallazgo.count({ where: { id: payload.id } })).toBe(1);
  });

  it('otro supervisor con el mismo id -> 409 ID_CONFLICT y no pisa la fila', async () => {
    const payload = hallazgoPayload();
    createdHallazgoIds.push(payload.id);
    await supervisorAgent.post('/api/hallazgos').send(payload).expect(201);

    const response = await supervisorBAgent
      .post('/api/hallazgos')
      .send({ ...payload, descripcion: 'Otra cosa' })
      .expect(409);

    expect((response.body as ErrorEnvelope).code).toBe('ID_CONFLICT');
    const row = await prisma.hallazgo.findUniqueOrThrow({
      where: { id: payload.id },
    });
    expect(row.descripcion).toBe(payload.descripcion);
  });

  it('capturedAt queda como fecha del hallazgo', async () => {
    const capturedAt = new Date(Date.now() - 2 * 3_600_000);
    const payload = hallazgoPayload({ capturedAt: capturedAt.toISOString() });
    createdHallazgoIds.push(payload.id);

    const response = await supervisorAgent
      .post('/api/hallazgos')
      .send(payload)
      .expect(201);

    const data = (response.body as ApiEnvelope<HallazgoData>).data;
    expect(new Date(data.fecha).getTime()).toBe(capturedAt.getTime());
    const row = await prisma.hallazgo.findUniqueOrThrow({
      where: { id: payload.id },
    });
    expect(row.createdAt.getTime()).toBeGreaterThan(capturedAt.getTime());
  });

  it('un capturedAt absurdo -> 400 INVALID_CAPTURE_TIME', async () => {
    const response = await supervisorAgent
      .post('/api/hallazgos')
      .send(hallazgoPayload({ capturedAt: '2001-01-01T00:00:00.000Z' }))
      .expect(400);

    expect((response.body as ErrorEnvelope).code).toBe('INVALID_CAPTURE_TIME');
  });

  it('un id que no es UUID v4 -> 400', async () => {
    await supervisorAgent
      .post('/api/hallazgos')
      .send(hallazgoPayload({ id: 'no-es-uuid' }))
      .expect(400);
  });

  it('sin id sigue funcionando como antes -> 201', async () => {
    const sinId = { ...hallazgoPayload(), id: undefined };

    const response = await supervisorAgent
      .post('/api/hallazgos')
      .send(sinId)
      .expect(201);

    const data = (response.body as ApiEnvelope<HallazgoData>).data;
    createdHallazgoIds.push(data.id);
    const row = await prisma.hallazgo.findUniqueOrThrow({
      where: { id: data.id },
    });
    expect(row.createdById).not.toBeNull();
  });

  it('MANTENEDOR -> 403', async () => {
    await mantenedorAgent
      .post('/api/hallazgos')
      .send(hallazgoPayload())
      .expect(403);
  });
});
