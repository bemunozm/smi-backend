/**
 * Prueba e2e de AdBlue al cierre y de la edición de
 * tarjetas ya enviadas: `POST /api/shift-cards/:id/close` con AdBlue,
 * `PATCH /api/shift-cards/:id` y `GET /api/shift-cards/:id/changes` contra una
 * app Nest real (mismo pipeline que `main.ts`, vía `configureApp`) y Postgres
 * + MinIO REALES.
 *
 * Cubre lo que la cola offline de la tablet necesita: la edición es segura de
 * reintentar (idempotente) y una edición hecha sobre datos que otro ya
 * cambió se rechaza (409 `STALE_UPDATE`) en vez de pisarlos.
 *
 * Bucket dedicado y equipos/usuarios frescos por corrida, igual que
 * `shift-register.e2e-spec.ts`. Se salta completo si MinIO o Postgres no
 * están arriba.
 */
import { randomUUID } from 'node:crypto';

import { isMinioReachable, isPostgresReachable } from './helpers/reachability';

const minioReachable = isMinioReachable();
const postgresReachable = isPostgresReachable();

const TEST_BUCKET = 'smi-shift-card-edit-e2e';
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
import { DOMAIN_EVENTS } from '../src/common/events/domain-events';
import { todayInBusinessTimeZone } from '../src/common/dates/business-time';
import { ApiEnvelope, ErrorEnvelope } from './helpers/api-envelope';
import { bootstrapApp } from './helpers/bootstrap-app';
import {
  baseEquipmentPayload,
  EquipmentData,
  OperatorData,
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
    `shift-card-edit.e2e-spec: SALTEADO (MinIO reachable=${minioReachable}, ` +
      `Postgres reachable=${postgresReachable}) — levantar con ` +
      '"docker compose up -d minio minio-init smi-postgres"',
  );
}

const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
]);

interface UploadFileData {
  key: string;
}
interface UserData {
  id: string;
  email: string;
  [key: string]: unknown;
}
interface ShiftCardData {
  id: string;
  valorInicial: number;
  valorFinal: number | null;
  horasMaquina: number | null;
  fuelLiters: number | null;
  adBlue: boolean;
  adBlueLiters: number | null;
  operatorId: string | null;
  operatorName: string;
  observaciones: string | null;
  shift: { id: string } | null;
  [key: string]: unknown;
}
interface ChangeEntry {
  id: string;
  userId: string;
  userName: string;
  changes: { field: string; label: string; before: string; after: string }[];
  createdAt: string;
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

maybeDescribe('Tarjetas de turno — AdBlue y edición (e2e)', () => {
  jest.setTimeout(30_000);

  let app: NestExpressApplication;
  let prisma: PrismaService;
  let rawS3: S3Client;

  let adminAgent: SupertestAgent;
  let supervisorAgent: SupertestAgent;
  let supervisorBAgent: SupertestAgent;
  let mantenedorAgent: SupertestAgent;

  let supervisorAUserId: string;
  let supervisorBUserId: string;
  let operators: OperatorData[];

  const RUN_ID = randomUUID().slice(0, 5);
  const internalCode = (suffix: string) => `SCE-${RUN_ID}-${suffix}`;
  const todayShiftDate = todayInBusinessTimeZone(new Date());

  const createdEquipmentIds: string[] = [];
  const createdShiftIds = new Set<string>();
  const createdCardIds: string[] = [];
  const startedAt = new Date();

  async function openCard(
    agent: SupertestAgent,
    equipo: EquipmentData,
    operatorId: string,
    valorInicial = 100,
  ): Promise<string> {
    const id = randomUUID();
    const response = await agent
      .post('/api/shift-cards')
      .send({
        id,
        equipoId: equipo.id,
        operatorId,
        valorInicial,
        shiftDate: todayShiftDate,
        shiftType: 'DIURNO',
        capturedAt: new Date().toISOString(),
      })
      .expect(201);
    const card = (response.body as ApiEnvelope<ShiftCardData>).data;
    if (card.shift) createdShiftIds.add(card.shift.id);
    createdCardIds.push(id);
    return id;
  }

  async function uploadPhoto(agent: SupertestAgent): Promise<string> {
    const response = await agent
      .post('/api/files')
      .attach('file', MINIMAL_JPEG, 'surtidor.jpg')
      .expect(201);
    return (response.body as ApiEnvelope<UploadFileData>).data.key;
  }

  async function createEquipo(suffix: string): Promise<EquipmentData> {
    const response = await adminAgent
      .post('/api/equipment')
      .send(baseEquipmentPayload(internalCode(suffix)))
      .expect(201);
    const equipo = (response.body as ApiEnvelope<EquipmentData>).data;
    createdEquipmentIds.push(equipo.id);
    return equipo;
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
    supervisorAUserId = (
      await prisma.user.findUniqueOrThrow({
        where: { email: 'supervisor@smi.local' },
        select: { id: true },
      })
    ).id;

    const createUserResponse = await adminAgent
      .post('/api/users')
      .send({
        name: 'Supervisor B (e2e edit)',
        email: `supervisor-b-edit-${RUN_ID}@e2e.smi.local`,
        password: SEED_PASSWORD,
        role: ROLES.SUPERVISOR,
      })
      .expect(201);
    const supervisorBUser = (createUserResponse.body as ApiEnvelope<UserData>)
      .data;
    supervisorBUserId = supervisorBUser.id;
    supervisorBAgent = await loginAgent(
      app,
      supervisorBUser.email,
      SEED_PASSWORD,
    );

    const operatorsResponse = await supervisorAgent
      .get('/api/operators')
      .query({ isActive: true })
      .expect(200);
    operators = (operatorsResponse.body as ApiEnvelope<OperatorData[]>).data;
    if (operators.length < 2) {
      throw new Error(
        'Hacen falta 2 operadores activos en el catálogo — ¿corrió "npm run db:seed"?',
      );
    }
  });

  afterAll(async () => {
    if (createdCardIds.length > 0) {
      await prisma.changeLog.deleteMany({
        where: { entityId: { in: createdCardIds } },
      });
      await prisma.notification.deleteMany({
        where: {
          tipo: DOMAIN_EVENTS.RECORD_EDITED,
          createdAt: { gte: startedAt },
          OR: createdCardIds.map((id) => ({
            data: { path: ['entityId'], equals: id },
          })),
        },
      });
    }
    if (createdEquipmentIds.length > 0) {
      await prisma.registroCombustible.deleteMany({
        where: { equipoId: { in: createdEquipmentIds } },
      });
      await prisma.registroHorometro.deleteMany({
        where: { equipoId: { in: createdEquipmentIds } },
      });
      await prisma.shift.deleteMany({
        where: { id: { in: Array.from(createdShiftIds) } },
      });
      await prisma.equipment.deleteMany({
        where: { id: { in: createdEquipmentIds } },
      });
    }
    if (supervisorBUserId) {
      await adminAgent.delete(`/api/users/${supervisorBUserId}`).expect(200);
    }
    await deleteAllObjects(rawS3, TEST_BUCKET);
    await app.close();
  });

  describe('AdBlue al cierre', () => {
    let equipo: EquipmentData;
    let cardId: string;

    it('prepara una tarjeta abierta', async () => {
      equipo = await createEquipo('ADBLUE');
      cardId = await openCard(supervisorAgent, equipo, operators[0].id);
    });

    it('rechaza AdBlue sin litros, con litros fuera de rango y litros sin AdBlue -> 400', async () => {
      const key = await uploadPhoto(supervisorAgent);
      const base = {
        closeClientId: randomUUID(),
        valorFinal: 130,
        fuelLiters: 0,
        tmpPhotoKey: key,
        capturedAt: new Date().toISOString(),
      };

      for (const extra of [
        { adBlue: true },
        { adBlue: true, adBlueLiters: 0 },
        { adBlue: true, adBlueLiters: 1001 },
        { adBlue: false, adBlueLiters: 5 },
      ]) {
        const response = await supervisorAgent
          .post(`/api/shift-cards/${cardId}/close`)
          .send({ ...base, ...extra })
          .expect(400);
        expect((response.body as ErrorEnvelope).message).toMatch(/AdBlue/);
      }

      const row = await prisma.registroHorometro.findUniqueOrThrow({
        where: { id: cardId },
        select: { valorFinal: true },
      });
      expect(row.valorFinal).toBeNull();
    });

    it('cierra con AdBlue -> la respuesta y la base lo llevan', async () => {
      const response = await supervisorAgent
        .post(`/api/shift-cards/${cardId}/close`)
        .send({
          closeClientId: randomUUID(),
          valorFinal: 130,
          fuelLiters: 0,
          adBlue: true,
          adBlueLiters: 12.5,
          tmpPhotoKey: await uploadPhoto(supervisorAgent),
          capturedAt: new Date().toISOString(),
        })
        .expect(200);

      const card = (response.body as ApiEnvelope<ShiftCardData>).data;
      expect(card.adBlue).toBe(true);
      expect(card.adBlueLiters).toBe(12.5);

      const row = await prisma.registroHorometro.findUniqueOrThrow({
        where: { id: cardId },
        select: { adBlue: true, adBlueLiters: true },
      });
      expect(row).toEqual({ adBlue: true, adBlueLiters: 12.5 });
    });

    it('un cierre antiguo, sin los campos nuevos, sigue siendo válido y queda sin AdBlue', async () => {
      const otro = await createEquipo('LEGACY');
      const id = await openCard(supervisorAgent, otro, operators[0].id);

      const response = await supervisorAgent
        .post(`/api/shift-cards/${id}/close`)
        .send({
          closeClientId: randomUUID(),
          valorFinal: 110,
          fuelLiters: 0,
          tmpPhotoKey: await uploadPhoto(supervisorAgent),
          capturedAt: new Date().toISOString(),
        })
        .expect(200);

      const card = (response.body as ApiEnvelope<ShiftCardData>).data;
      expect(card.adBlue).toBe(false);
      expect(card.adBlueLiters).toBeNull();
    });
  });

  describe('Edición de una tarjeta cerrada', () => {
    let equipo: EquipmentData;
    let cardId: string;

    const patch = (
      agent: SupertestAgent,
      body: Record<string, unknown>,
      expected?: Record<string, unknown>,
      id = cardId,
    ) => {
      const req = agent.patch(`/api/shift-cards/${id}`);
      if (expected)
        req.set('X-Expected', encodeURIComponent(JSON.stringify(expected)));
      return req.send(body);
    };
    const linkedFuel = () =>
      prisma.registroCombustible.findUnique({
        where: { registroHorometroId: cardId },
      });

    it('prepara una tarjeta cerrada sin combustible', async () => {
      equipo = await createEquipo('EDIT');
      cardId = await openCard(supervisorAgent, equipo, operators[0].id);
      await supervisorAgent
        .post(`/api/shift-cards/${cardId}/close`)
        .send({
          closeClientId: randomUUID(),
          valorFinal: 130,
          fuelLiters: 0,
          tmpPhotoKey: await uploadPhoto(supervisorAgent),
          capturedAt: new Date().toISOString(),
        })
        .expect(200);

      expect(await linkedFuel()).toBeNull();
    });

    it('litros 0 -> 20: crea la carga vinculada con la foto de la tarjeta', async () => {
      const response = await patch(
        supervisorAgent,
        { fuelLiters: 20 },
        { fuelLiters: 0 },
      ).expect(200);
      expect(
        (response.body as ApiEnvelope<ShiftCardData>).data.fuelLiters,
      ).toBe(20);

      const fuel = await linkedFuel();
      const card = await prisma.registroHorometro.findUniqueOrThrow({
        where: { id: cardId },
        select: { pumpPhotoKey: true },
      });
      expect(fuel).toMatchObject({
        litros: 20,
        equipoId: equipo.id,
        tipo: 'PETROLEO',
        fotoKey: card.pumpPhotoKey,
      });
    });

    it('REPLAY del mismo PATCH con X-Expected: 200 idempotente, sin segundo cambio ni segunda carga', async () => {
      const antes = await prisma.changeLog.count({
        where: { entity: 'shift_card', entityId: cardId },
      });

      const response = await patch(
        supervisorAgent,
        { fuelLiters: 20 },
        { fuelLiters: 0 },
      ).expect(200);
      expect(
        (response.body as ApiEnvelope<ShiftCardData>).data.fuelLiters,
      ).toBe(20);

      expect(
        await prisma.changeLog.count({
          where: { entity: 'shift_card', entityId: cardId },
        }),
      ).toBe(antes);
      expect(
        await prisma.registroCombustible.count({
          where: { registroHorometroId: cardId },
        }),
      ).toBe(1);
    });

    it('X-Expected desactualizado -> 409 STALE_UPDATE y no pisa el dato', async () => {
      const response = await patch(
        supervisorAgent,
        { fuelLiters: 30 },
        { fuelLiters: 0 },
      ).expect(409);
      const body = response.body as ErrorEnvelope;
      expect(body.code).toBe('STALE_UPDATE');
      expect(body.message).toContain('Litros de combustible');

      expect((await linkedFuel())?.litros).toBe(20);
    });

    it('sin X-Expected la última escritura gana, y actualiza la carga existente', async () => {
      await patch(supervisorAgent, { fuelLiters: 35 }).expect(200);

      expect((await linkedFuel())?.litros).toBe(35);
      expect(
        await prisma.registroCombustible.count({
          where: { registroHorometroId: cardId },
        }),
      ).toBe(1);
    });

    it('litros 35 -> 0: borra la carga vinculada', async () => {
      await patch(
        supervisorAgent,
        { fuelLiters: 0 },
        { fuelLiters: 35 },
      ).expect(200);

      expect(await linkedFuel()).toBeNull();
    });

    it('subir la lectura final reconcilia el contador del equipo y recalcula las horas', async () => {
      const response = await patch(
        supervisorAgent,
        { valorFinal: 142 },
        { valorFinal: 130 },
      ).expect(200);
      expect(
        (response.body as ApiEnvelope<ShiftCardData>).data.horasMaquina,
      ).toBe(42);

      const equipoRow = await prisma.equipment.findUniqueOrThrow({
        where: { id: equipo.id },
        select: { currentHourmeter: true },
      });
      expect(equipoRow.currentHourmeter).toBe(142);
    });

    it('bajar la lectura final no baja el contador ni falla', async () => {
      await patch(supervisorAgent, { valorFinal: 120 }).expect(200);

      const equipoRow = await prisma.equipment.findUniqueOrThrow({
        where: { id: equipo.id },
        select: { currentHourmeter: true },
      });
      expect(equipoRow.currentHourmeter).toBe(142);
    });

    it('lectura final bajo la inicial -> 400 HOURMETER_BELOW_INITIAL', async () => {
      const response = await patch(supervisorAgent, { valorFinal: 50 }).expect(
        400,
      );
      expect((response.body as ErrorEnvelope).code).toBe(
        'HOURMETER_BELOW_INITIAL',
      );
    });

    it('cambia el operador por catálogo y rederiva el nombre', async () => {
      const response = await patch(supervisorAgent, {
        operatorId: operators[1].id,
      }).expect(200);
      const card = (response.body as ApiEnvelope<ShiftCardData>).data;
      expect(card.operatorId).toBe(operators[1].id);
      expect(card.operatorName).toBe(operators[1].name);
    });

    it('agrega AdBlue consistente y rechaza el inconsistente', async () => {
      await patch(supervisorAgent, { adBlueLiters: 10 }).expect(400);
      await patch(supervisorAgent, { adBlue: true }).expect(400);

      const response = await patch(supervisorAgent, {
        adBlue: true,
        adBlueLiters: 15,
      }).expect(200);
      expect((response.body as ApiEnvelope<ShiftCardData>).data).toMatchObject({
        adBlue: true,
        adBlueLiters: 15,
      });
    });

    it('un X-Expected que no es JSON -> 400, y un body vacío -> 400', async () => {
      await supervisorAgent
        .patch(`/api/shift-cards/${cardId}`)
        .set('X-Expected', encodeURIComponent('{no-json'))
        .send({ observaciones: 'x' })
        .expect(400);
      await patch(supervisorAgent, {}).expect(400);
    });

    it('un campo que no se edita -> 400 (forbidNonWhitelisted)', async () => {
      await patch(supervisorAgent, { equipoId: 'otro' }).expect(400);
    });

    it('GET /changes lista los cambios, el más reciente primero, con la forma de hallazgos', async () => {
      const response = await supervisorAgent
        .get(`/api/shift-cards/${cardId}/changes`)
        .expect(200);
      const entries = (response.body as ApiEnvelope<ChangeEntry[]>).data;

      // fuel 0->20, 20->35, 35->0, valorFinal 130->142, 142->120, operador, AdBlue
      expect(entries).toHaveLength(7);
      expect(entries[0].changes.map((c) => c.field)).toEqual(
        expect.arrayContaining(['adBlue', 'adBlueLiters']),
      );
      expect(entries[0]).toMatchObject({
        userId: supervisorAUserId,
        userName: expect.any(String) as string,
        createdAt: expect.any(String) as string,
        id: expect.any(String) as string,
      });
      const first = entries[entries.length - 1];
      expect(first.changes).toEqual([
        {
          field: 'fuelLiters',
          label: 'Litros de combustible',
          before: '0',
          after: '20',
        },
      ]);
      const operador = entries.find((e) =>
        e.changes.some((c) => c.field === 'operatorId'),
      );
      expect(operador?.changes[0]).toEqual({
        field: 'operatorId',
        label: 'Operador',
        before: operators[0].name,
        after: operators[1].name,
      });
    });

    it('cada edición real avisa al administrador (record.edited)', async () => {
      const notification = await waitFor(async () => {
        const rows = await prisma.notification.findMany({
          where: {
            tipo: DOMAIN_EVENTS.RECORD_EDITED,
            createdAt: { gte: startedAt },
          },
        });
        return rows.find(
          (r) =>
            (r.data as { entityId?: string } | null)?.entityId === cardId &&
            (r.data as { entity?: string } | null)?.entity === 'shift_card',
        );
      }, 'notificación record.edited de la tarjeta');
      expect(notification.titulo).toContain('tarjeta de turno');
    });

    it('un PATCH que no cambia nada no deja registro', async () => {
      const antes = await prisma.changeLog.count({
        where: { entity: 'shift_card', entityId: cardId },
      });

      await patch(supervisorAgent, { valorFinal: 120, fuelLiters: 0 }).expect(
        200,
      );

      expect(
        await prisma.changeLog.count({
          where: { entity: 'shift_card', entityId: cardId },
        }),
      ).toBe(antes);
    });

    it('X-Expected con texto no ASCII viaja codificado y se compara bien', async () => {
      const texto = 'Revisión — “ok” ñ 🚜';
      await patch(supervisorAgent, { observaciones: texto }).expect(200);

      await patch(
        supervisorAgent,
        { observaciones: 'Siguiente' },
        { observaciones: texto },
      ).expect(200);

      const stale = await patch(
        supervisorAgent,
        { observaciones: 'Otra' },
        { observaciones: texto },
      ).expect(409);
      expect((stale.body as ErrorEnvelope).code).toBe('STALE_UPDATE');
    });

    it('un campo de X-Expected que el body no toca no genera conflicto', async () => {
      await patch(
        supervisorAgent,
        { observaciones: 'Siguiente' },
        { valorFinal: 1 },
      ).expect(200);
    });

    it('otro supervisor -> 403 NOT_OWNER en PATCH y en /changes', async () => {
      const edit = await patch(supervisorBAgent, {
        observaciones: 'intruso',
      }).expect(403);
      expect((edit.body as ErrorEnvelope).code).toBe('NOT_OWNER');

      const changes = await supervisorBAgent
        .get(`/api/shift-cards/${cardId}/changes`)
        .expect(403);
      expect((changes.body as ErrorEnvelope).code).toBe('NOT_OWNER');
    });

    it('MANTENEDOR -> 403 en PATCH y en /changes', async () => {
      await patch(mantenedorAgent, { observaciones: 'no' }).expect(403);
      await mantenedorAgent
        .get(`/api/shift-cards/${cardId}/changes`)
        .expect(403);
    });

    it('un ADMIN puede editar y leer el historial de una tarjeta ajena', async () => {
      await patch(adminAgent, { observaciones: 'Revisado por admin' }).expect(
        200,
      );
      const response = await adminAgent
        .get(`/api/shift-cards/${cardId}/changes`)
        .expect(200);
      const entries = (response.body as ApiEnvelope<ChangeEntry[]>).data;
      expect(entries[0].changes[0].field).toBe('observaciones');
      expect(entries[0].userId).not.toBe(supervisorAUserId);
    });

    it('una tarjeta inexistente -> 404 CARD_NOT_FOUND', async () => {
      const response = await patch(
        supervisorAgent,
        { observaciones: 'x' },
        undefined,
        randomUUID(),
      ).expect(404);
      expect((response.body as ErrorEnvelope).code).toBe('CARD_NOT_FOUND');
    });
  });

  describe('Edición de una tarjeta abierta', () => {
    it('lectura final, combustible y AdBlue -> 409 CARD_NOT_CLOSED; las observaciones sí se editan', async () => {
      const equipo = await createEquipo('OPEN');
      const id = await openCard(supervisorAgent, equipo, operators[0].id);

      for (const body of [
        { valorFinal: 130 },
        { fuelLiters: 10 },
        { adBlue: true, adBlueLiters: 5 },
      ]) {
        const response = await supervisorAgent
          .patch(`/api/shift-cards/${id}`)
          .send(body)
          .expect(409);
        expect((response.body as ErrorEnvelope).code).toBe('CARD_NOT_CLOSED');
      }

      const ok = await supervisorAgent
        .patch(`/api/shift-cards/${id}`)
        .send({ observaciones: 'Falla en el espejo', valorInicial: 101 })
        .expect(200);
      expect((ok.body as ApiEnvelope<ShiftCardData>).data).toMatchObject({
        observaciones: 'Falla en el espejo',
        valorInicial: 101,
        valorFinal: null,
      });
    });
  });
});
