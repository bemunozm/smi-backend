/**
 * Gate e2e completo de Supervisión en Terreno, Módulo A (RFC "Supervisión en
 * Terreno: Módulo A real + offline + roles/operadores + cierre de R2", Fase
 * 7 — único punto del plan donde corre este archivo): ejercita el contrato
 * de replay offline (`src/shifts/*`) contra una app Nest real (mismo
 * pipeline que `main.ts`, vía `configureApp`) y contra Postgres + MinIO
 * REALES (sin mocks) — abrir tarjeta, subir foto, cerrar, reportar salida, y
 * cada camino de reintento/idempotencia que el outbox offline del tablet
 * necesita.
 *
 * Bucket DEDICADO (`smi-shift-register-e2e`, distinto del `smi-files-e2e` de
 * `files-storage.e2e-spec.ts` y del `smi-files` de dev) — mismo patrón que
 * ese archivo. `STORAGE_BUCKET` se fija en `process.env` ANTES de importar
 * `AppModule`/`env` (ver el comentario junto a esa línea).
 *
 * Equipos/usuarios: SIEMPRE creados frescos por el test (nunca equipos
 * sembrados) — así un rerun no choca con `EQUIPMENT_BUSY` de una tarjeta
 * abierta que quedó de una corrida anterior. El operador SÍ se reusa del
 * seed (catálogo, no hay motivo para duplicarlo).
 *
 * Se salta completo (`describe.skip`) si MinIO o Postgres no están arriba —
 * mismo patrón síncrono que `files-storage.e2e-spec.ts`.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function isMinioReachable(): boolean {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "fetch('http://localhost:9000/minio/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ],
    { timeout: 5000 },
  );
  return result.status === 0;
}

/** Chequeo TCP crudo — ver el mismo comentario en `files-storage.e2e-spec.ts`. */
function isPostgresReachable(): boolean {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "const net=require('net');const s=net.createConnection({host:'localhost',port:5434},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(3000,()=>{s.destroy();process.exit(1)});",
    ],
    { timeout: 5000 },
  );
  return result.status === 0;
}

const minioReachable = isMinioReachable();
const postgresReachable = isPostgresReachable();

const TEST_BUCKET = 'smi-shift-register-e2e';
// IMPORTANTE: `env.ts` lee `process.env.STORAGE_BUCKET` en IMPORT-TIME — ver
// el comentario detallado (empírico, verificado) en la cabecera de
// `files-storage.e2e-spec.ts`. Esta asignación debe correr ANTES del primer
// `import` real de `AppModule`/`env`/cualquier cosa que los arrastre.
process.env.STORAGE_BUCKET = TEST_BUCKET;

import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { ControlUnit, EquipmentClass } from '@prisma/client';

import { AppModule } from '../src/app.module';
import { configureApp, NEST_APP_CREATE_OPTIONS } from '../src/app.setup';
import { ROLES } from '../src/auth/roles';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  DEFAULT_DEV_STORAGE_ACCESS_KEY_ID,
  DEFAULT_DEV_STORAGE_SECRET_ACCESS_KEY,
  env,
} from '../src/common/config/env';
import { DOMAIN_EVENTS } from '../src/common/events/domain-events';
import { todayInBusinessTimeZone } from '../src/shifts/date-only';

const maybeDescribe =
  minioReachable && postgresReachable ? describe : describe.skip;

if (!minioReachable || !postgresReachable) {
  console.warn(
    `shift-register.e2e-spec: SALTEADO (MinIO reachable=${minioReachable}, ` +
      `Postgres reachable=${postgresReachable}) — levantar con ` +
      '"docker compose up -d minio minio-init smi-postgres"',
  );
}

const SEED_PASSWORD = 'Smi123456!';
type SupertestAgent = ReturnType<typeof request.agent>;

const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
]);

interface ApiEnvelope<T> {
  data: T;
  message: string;
}
interface ErrorEnvelope {
  data: null;
  message: string;
  code?: string;
}
interface UploadFileData {
  key: string;
  url: string;
}
interface OperatorData {
  id: string;
  name: string;
  isActive: boolean;
  [key: string]: unknown;
}
interface EquipmentData {
  id: string;
  internalCode: string;
  [key: string]: unknown;
}
interface UserData {
  id: string;
  email: string;
  [key: string]: unknown;
}
interface ShiftCardData {
  id: string;
  equipoId: string;
  operatorId: string | null;
  supervisorId: string | null;
  shift: { id: string; date: string; type: string } | null;
  valorInicial: number;
  valorFinal: number | null;
  horasMaquina: number | null;
  fuelLiters: number | null;
  pumpPhotoUrl: string | null;
  belowPreviousReading: boolean;
  fecha: string;
  fechaSalida: string | null;
  createdAt: string;
  closedAt: string | null;
  [key: string]: unknown;
}
interface ShiftReportData {
  id: string;
  shiftId: string;
  fileName: string;
  cardCount: number;
  requestedAt: string;
  createdAt: string;
  emailStatus: string;
  missingCardIds: string[];
}
interface CreateEquipmentPayload {
  internalCode: string;
  equipmentClass: EquipmentClass;
  type: string;
  brand: string;
  model: string;
  controlUnit: ControlUnit;
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

async function countObjectsWithPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<number> {
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
  );
  return listed.Contents?.length ?? 0;
}

async function loginAgent(
  app: NestExpressApplication,
  email: string,
  password: string,
): Promise<SupertestAgent> {
  const agent = request.agent(app.getHttpServer());
  const response = await agent
    .post('/api/auth/sign-in/email')
    .set('Origin', env.frontendUrl)
    .send({ email, password });
  if (response.status !== 200) {
    throw new Error(
      `No se pudo iniciar sesión como "${email}": ${response.status} ` +
        JSON.stringify(response.body),
    );
  }
  return agent;
}

async function uploadViaApi(
  agent: SupertestAgent,
  buffer: Buffer,
  filename: string,
): Promise<UploadFileData> {
  const response = await agent
    .post('/api/files')
    .attach('file', buffer, filename)
    .expect(201);
  return (response.body as ApiEnvelope<UploadFileData>).data;
}

/** Key `tmp/<userId>/<uuid>.<ext>` BIEN FORMADA pero que nunca se subió —
 * pasa la validación de forma de `TMP_KEY_REGEX` en el DTO, pero
 * `StorageService.claimTmp` la rechaza (`CopyObjectCommand` 404 NoSuchKey →
 * 400 `TMP_KEY_EXPIRED`) si de verdad se reclama. */
function wellFormedTmpKey(userId: string, ext = 'jpg'): string {
  return `tmp/${userId}/${randomUUID()}.${ext}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Poll corto — el listener de `SHIFT_EXIT_REPORT_SENT` corre fire-and-forget
 * (`eventEmitter.emit`, no `emitAsync`): la request HTTP ya respondió antes
 * de que el correo/la notificación in-app terminen de procesarse. */
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

function baseEquipmentPayload(internalCode: string): CreateEquipmentPayload {
  return {
    internalCode,
    equipmentClass: EquipmentClass.HEAVY,
    type: 'Excavadora',
    brand: 'Caterpillar',
    model: '320',
    controlUnit: ControlUnit.HOURS,
  };
}

maybeDescribe('Supervisión en Terreno — tarjetas de turno (e2e)', () => {
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
  let supervisorBUserData: UserData;
  let adminUserId: string;
  let operatorId: string;

  // `internalCode` tiene @MaxLength(20) — "SFT-" (4) + RUN_ID (5) + "-" (1) =
  // 10 chars fijos, deja 10 para el sufijo.
  const RUN_ID = randomUUID().slice(0, 5);
  const internalCode = (suffix: string) => `SFT-${RUN_ID}-${suffix}`;
  const todayShiftDate = todayInBusinessTimeZone(new Date());

  const createdEquipmentIds: string[] = [];
  const createdShiftIds = new Set<string>();

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

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>(
      NEST_APP_CREATE_OPTIONS,
    );
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);

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

    const [supervisorAUser, adminUser] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { email: 'supervisor@smi.local' },
        select: { id: true },
      }),
      prisma.user.findUniqueOrThrow({
        where: { email: 'admin@smi.local' },
        select: { id: true },
      }),
    ]);
    supervisorAUserId = supervisorAUser.id;
    adminUserId = adminUser.id;

    // Segundo supervisor, creado fresco por el test (RFC Supervisión en
    // Terreno solo siembra UN supervisor) — necesario para el escenario de
    // dueño de tarjeta (M1a). Se limpia en `afterAll` vía la API real
    // (`DELETE /api/users/:id`, Better Auth admin), no a mano en Prisma.
    const createUserResponse = await adminAgent
      .post('/api/users')
      .send({
        name: 'Supervisor B (e2e)',
        email: `supervisor-b-${RUN_ID}@e2e.smi.local`,
        password: SEED_PASSWORD,
        role: ROLES.SUPERVISOR,
      })
      .expect(201);
    supervisorBUserData = (createUserResponse.body as ApiEnvelope<UserData>)
      .data;
    supervisorBUserId = supervisorBUserData.id;
    supervisorBAgent = await loginAgent(
      app,
      supervisorBUserData.email,
      SEED_PASSWORD,
    );

    const operatorsResponse = await supervisorAgent
      .get('/api/operators')
      .query({ isActive: true })
      .expect(200);
    const operators = (operatorsResponse.body as ApiEnvelope<OperatorData[]>)
      .data;
    if (operators.length === 0) {
      throw new Error(
        'No hay operadores activos en el catálogo — ¿corrió "npm run db:seed"?',
      );
    }
    operatorId = operators[0].id;
  });

  afterAll(async () => {
    if (createdEquipmentIds.length > 0) {
      await prisma.notification.deleteMany({
        where: {
          tipo: DOMAIN_EVENTS.SHIFT_EXIT_REPORT_SENT,
          userId: adminUserId,
          createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
      });
      await prisma.shiftExitReport.deleteMany({
        where: { shiftId: { in: Array.from(createdShiftIds) } },
      });
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

  // Compartido entre el flujo 1 (abre) y el flujo 2 (cierra) — misma tarjeta.
  let flow2Equipo: EquipmentData;
  let flow2CardId: string;

  describe('1) Apertura de tarjeta — idempotencia y ocupado', () => {
    let equipo: EquipmentData;
    let cardId: string;

    it('crea el equipo fresco para este flujo', async () => {
      const response = await adminAgent
        .post('/api/equipment')
        .send(baseEquipmentPayload(internalCode('PRINCIPAL')))
        .expect(201);
      equipo = (response.body as ApiEnvelope<EquipmentData>).data;
      createdEquipmentIds.push(equipo.id);
      flow2Equipo = equipo;
    });

    it('abre la tarjeta -> 201', async () => {
      cardId = randomUUID();
      const dto = {
        id: cardId,
        equipoId: equipo.id,
        operatorId,
        valorInicial: 100,
        shiftDate: todayShiftDate,
        shiftType: 'DIURNO',
        capturedAt: new Date().toISOString(),
      };

      const response = await supervisorAgent
        .post('/api/shift-cards')
        .send(dto)
        .expect(201);
      const card = (response.body as ApiEnvelope<ShiftCardData>).data;
      expect(card.id).toBe(cardId);
      expect(card.valorInicial).toBe(100);
      expect(card.valorFinal).toBeNull();
      expect(card.shift).not.toBeNull();
      if (card.shift) createdShiftIds.add(card.shift.id);
      flow2CardId = cardId;

      const count = await prisma.registroHorometro.count({
        where: { equipoId: equipo.id },
      });
      expect(count).toBe(1);
    });

    it('REPLAY de la misma request -> misma tarjeta, sin duplicar fila', async () => {
      const dto = {
        id: cardId,
        equipoId: equipo.id,
        operatorId,
        valorInicial: 100,
        shiftDate: todayShiftDate,
        shiftType: 'DIURNO',
        capturedAt: new Date().toISOString(),
      };

      const response = await supervisorAgent
        .post('/api/shift-cards')
        .send(dto)
        .expect(201);
      const card = (response.body as ApiEnvelope<ShiftCardData>).data;
      expect(card.id).toBe(cardId);

      const count = await prisma.registroHorometro.count({
        where: { equipoId: equipo.id },
      });
      expect(count).toBe(1);
    });

    it('el mismo equipo con OTRO id -> 409 EQUIPMENT_BUSY', async () => {
      const response = await supervisorAgent
        .post('/api/shift-cards')
        .send({
          id: randomUUID(),
          equipoId: equipo.id,
          operatorId,
          valorInicial: 105,
          shiftDate: todayShiftDate,
          shiftType: 'DIURNO',
          capturedAt: new Date().toISOString(),
        })
        .expect(409);
      expect((response.body as ErrorEnvelope).code).toBe('EQUIPMENT_BUSY');
    });
  });

  describe('2) Foto + cierre — idempotencia y ya cerrada', () => {
    it('cierra la tarjeta con foto y litros -> 200, horas/foto/combustible/contador correctos', async () => {
      const upload = await uploadViaApi(
        supervisorAgent,
        MINIMAL_JPEG,
        'surtidor.jpg',
      );

      const response = await supervisorAgent
        .post(`/api/shift-cards/${flow2CardId}/close`)
        .send({
          closeClientId: randomUUID(),
          valorFinal: 130,
          fuelLiters: 45.5,
          tmpPhotoKey: upload.key,
          capturedAt: new Date().toISOString(),
        })
        .expect(200);

      const card = (response.body as ApiEnvelope<ShiftCardData>).data;
      expect(card.horasMaquina).toBe(round2(130 - 100));
      expect(card.pumpPhotoUrl).toBeTruthy();

      const fetched = await fetch(card.pumpPhotoUrl as string);
      expect(fetched.status).toBe(200);

      const raw = await prisma.registroHorometro.findUniqueOrThrow({
        where: { id: flow2CardId },
        select: { pumpPhotoKey: true },
      });
      expect(raw.pumpPhotoKey).toBeTruthy();

      const combustible = await prisma.registroCombustible.findFirst({
        where: { registroHorometroId: flow2CardId },
      });
      expect(combustible).not.toBeNull();
      expect(combustible?.fotoKey).toBe(raw.pumpPhotoKey);
      expect(combustible?.litros).toBe(45.5);

      const equipoRow = await prisma.equipment.findUniqueOrThrow({
        where: { id: flow2Equipo.id },
        select: { currentHourmeter: true },
      });
      expect(equipoRow.currentHourmeter).toBe(130);
    });

    it('REPLAY del cierre (mismo closeClientId) -> 200, misma tarjeta, sin reclamar la foto de nuevo', async () => {
      // El mismo closeClientId usado en el test anterior — se relee la
      // tarjeta ya cerrada para no duplicarlo a mano.
      const cardBeforeReplay = await prisma.registroHorometro.findUniqueOrThrow(
        {
          where: { id: flow2CardId },
          select: { closeClientId: true, pumpPhotoKey: true },
        },
      );

      const response = await supervisorAgent
        .post(`/api/shift-cards/${flow2CardId}/close`)
        .send({
          closeClientId: cardBeforeReplay.closeClientId,
          valorFinal: 130,
          fuelLiters: 45.5,
          // Key bien formada pero jamás subida — si el service intentara
          // reclamarla de nuevo, `claimTmp` fallaría con 400. Que la
          // respuesta siga siendo 200 prueba que NO se reclama dos veces.
          tmpPhotoKey: wellFormedTmpKey(supervisorAUserId),
          capturedAt: new Date().toISOString(),
        })
        .expect(200);

      const card = (response.body as ApiEnvelope<ShiftCardData>).data;
      expect(card.id).toBe(flow2CardId);
      expect(card.pumpPhotoUrl).toBeTruthy();

      const combustibleCount = await prisma.registroCombustible.count({
        where: { registroHorometroId: flow2CardId },
      });
      expect(combustibleCount).toBe(1);

      const equipoRow = await prisma.equipment.findUniqueOrThrow({
        where: { id: flow2Equipo.id },
        select: { currentHourmeter: true },
      });
      expect(equipoRow.currentHourmeter).toBe(130);
    });

    it('cierre con OTRO closeClientId sobre la tarjeta ya cerrada -> 409 ALREADY_CLOSED', async () => {
      const response = await supervisorAgent
        .post(`/api/shift-cards/${flow2CardId}/close`)
        .send({
          closeClientId: randomUUID(),
          valorFinal: 130,
          fuelLiters: 45.5,
          tmpPhotoKey: wellFormedTmpKey(supervisorAUserId),
          capturedAt: new Date().toISOString(),
        })
        .expect(409);
      expect((response.body as ErrorEnvelope).code).toBe('ALREADY_CLOSED');
    });
  });

  describe('3) Dueño de la tarjeta — otro supervisor (M1a)', () => {
    let equipo: EquipmentData;
    let cardId: string;
    let closeClientId: string;

    it('supervisor A abre y cierra una tarjeta', async () => {
      const equipoResponse = await adminAgent
        .post('/api/equipment')
        .send(baseEquipmentPayload(internalCode('OWNER')))
        .expect(201);
      equipo = (equipoResponse.body as ApiEnvelope<EquipmentData>).data;
      createdEquipmentIds.push(equipo.id);

      cardId = randomUUID();
      const openResponse = await supervisorAgent
        .post('/api/shift-cards')
        .send({
          id: cardId,
          equipoId: equipo.id,
          operatorId,
          valorInicial: 50,
          shiftDate: todayShiftDate,
          shiftType: 'DIURNO',
          capturedAt: new Date().toISOString(),
        })
        .expect(201);
      const openedCard = (openResponse.body as ApiEnvelope<ShiftCardData>).data;
      if (openedCard.shift) createdShiftIds.add(openedCard.shift.id);

      const upload = await uploadViaApi(
        supervisorAgent,
        MINIMAL_JPEG,
        'cierre.jpg',
      );
      closeClientId = randomUUID();
      await supervisorAgent
        .post(`/api/shift-cards/${cardId}/close`)
        .send({
          closeClientId,
          valorFinal: 60,
          fuelLiters: 0,
          tmpPhotoKey: upload.key,
          capturedAt: new Date().toISOString(),
        })
        .expect(200);
    });

    it('supervisor B con un closeClientId NUEVO -> 403 NOT_OWNER', async () => {
      const response = await supervisorBAgent
        .post(`/api/shift-cards/${cardId}/close`)
        .send({
          closeClientId: randomUUID(),
          valorFinal: 60,
          fuelLiters: 0,
          tmpPhotoKey: wellFormedTmpKey(supervisorBUserId),
          capturedAt: new Date().toISOString(),
        })
        .expect(403);
      expect((response.body as ErrorEnvelope).code).toBe('NOT_OWNER');
    });

    it('supervisor B reintentando el closeClientId DEL DUEÑO -> 403 NOT_OWNER (no 200 con la foto ajena)', async () => {
      const response = await supervisorBAgent
        .post(`/api/shift-cards/${cardId}/close`)
        .send({
          closeClientId,
          valorFinal: 60,
          fuelLiters: 0,
          tmpPhotoKey: wellFormedTmpKey(supervisorBUserId),
          capturedAt: new Date().toISOString(),
        })
        .expect(403);
      expect((response.body as ErrorEnvelope).code).toBe('NOT_OWNER');
    });
  });

  describe('4) Tmp key vencida o inexistente', () => {
    it('key bien formada pero nunca subida -> 400 TMP_KEY_EXPIRED', async () => {
      const equipoResponse = await adminAgent
        .post('/api/equipment')
        .send(baseEquipmentPayload(internalCode('TMPKEY')))
        .expect(201);
      const equipo = (equipoResponse.body as ApiEnvelope<EquipmentData>).data;
      createdEquipmentIds.push(equipo.id);

      const cardId = randomUUID();
      const openResponse = await supervisorAgent
        .post('/api/shift-cards')
        .send({
          id: cardId,
          equipoId: equipo.id,
          operatorId,
          valorInicial: 10,
          shiftDate: todayShiftDate,
          shiftType: 'DIURNO',
          capturedAt: new Date().toISOString(),
        })
        .expect(201);
      const opened = (openResponse.body as ApiEnvelope<ShiftCardData>).data;
      if (opened.shift) createdShiftIds.add(opened.shift.id);

      const response = await supervisorAgent
        .post(`/api/shift-cards/${cardId}/close`)
        .send({
          closeClientId: randomUUID(),
          valorFinal: 20,
          fuelLiters: 0,
          tmpPhotoKey: wellFormedTmpKey(supervisorAUserId),
          capturedAt: new Date().toISOString(),
        })
        .expect(400);
      expect((response.body as ErrorEnvelope).code).toBe('TMP_KEY_EXPIRED');
    });
  });

  describe('5) Validación de body y de shiftDate', () => {
    it('campo desconocido en el body -> 400 (forbidNonWhitelisted)', async () => {
      const equipoResponse = await adminAgent
        .post('/api/equipment')
        .send(baseEquipmentPayload(internalCode('BADBODY')))
        .expect(201);
      const equipo = (equipoResponse.body as ApiEnvelope<EquipmentData>).data;
      createdEquipmentIds.push(equipo.id);

      await supervisorAgent
        .post('/api/shift-cards')
        .send({
          id: randomUUID(),
          equipoId: equipo.id,
          operatorId,
          valorInicial: 10,
          shiftDate: todayShiftDate,
          shiftType: 'DIURNO',
          capturedAt: new Date().toISOString(),
          campoDesconocido: 'esto no debería existir',
        })
        .expect(400);
    });

    it('shiftDate "2026-02-31" (fecha de calendario inválida) -> 400', async () => {
      const equipoResponse = await adminAgent
        .post('/api/equipment')
        .send(baseEquipmentPayload(internalCode('BADDATE1')))
        .expect(201);
      const equipo = (equipoResponse.body as ApiEnvelope<EquipmentData>).data;
      createdEquipmentIds.push(equipo.id);

      await supervisorAgent
        .post('/api/shift-cards')
        .send({
          id: randomUUID(),
          equipoId: equipo.id,
          operatorId,
          valorInicial: 10,
          shiftDate: '2026-02-31',
          shiftType: 'DIURNO',
          capturedAt: new Date().toISOString(),
        })
        .expect(400);
    });

    it('shiftDate fuera de la ventana [-8, +1] días -> 400 INVALID_SHIFT_DATE', async () => {
      const equipoResponse = await adminAgent
        .post('/api/equipment')
        .send(baseEquipmentPayload(internalCode('BADDATE2')))
        .expect(201);
      const equipo = (equipoResponse.body as ApiEnvelope<EquipmentData>).data;
      createdEquipmentIds.push(equipo.id);

      const farPast = todayInBusinessTimeZone(
        new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      );

      const response = await supervisorAgent
        .post('/api/shift-cards')
        .send({
          id: randomUUID(),
          equipoId: equipo.id,
          operatorId,
          valorInicial: 10,
          shiftDate: farPast,
          shiftType: 'DIURNO',
          capturedAt: new Date().toISOString(),
        })
        .expect(400);
      expect((response.body as ErrorEnvelope).code).toBe('INVALID_SHIFT_DATE');
    });
  });

  describe('6) Reporte de salida — idempotencia, descarga y notificación', () => {
    let cardId: string;
    let reportId: string;
    let firstReport: ShiftReportData;
    const unknownCardId = randomUUID();

    it('abre una tarjeta para el turno del reporte', async () => {
      const equipoResponse = await adminAgent
        .post('/api/equipment')
        .send(baseEquipmentPayload(internalCode('REPORT')))
        .expect(201);
      const equipo = (equipoResponse.body as ApiEnvelope<EquipmentData>).data;
      createdEquipmentIds.push(equipo.id);

      cardId = randomUUID();
      const openResponse = await supervisorAgent
        .post('/api/shift-cards')
        .send({
          id: cardId,
          equipoId: equipo.id,
          operatorId,
          valorInicial: 5,
          shiftDate: todayShiftDate,
          shiftType: 'NOCTURNO',
          capturedAt: new Date().toISOString(),
        })
        .expect(201);
      const opened = (openResponse.body as ApiEnvelope<ShiftCardData>).data;
      if (opened.shift) createdShiftIds.add(opened.shift.id);
    });

    it('crea el reporte -> 201, missingCardIds con el id desconocido', async () => {
      const before = await countObjectsWithPrefix(
        rawS3,
        TEST_BUCKET,
        'reports/shift-exit/',
      );

      reportId = randomUUID();
      const response = await supervisorAgent
        .post('/api/shift-reports')
        .send({
          id: reportId,
          shiftDate: todayShiftDate,
          shiftType: 'NOCTURNO',
          cardIds: [cardId, unknownCardId],
          requestedAt: new Date().toISOString(),
        })
        .expect(201);

      firstReport = (response.body as ApiEnvelope<ShiftReportData>).data;
      expect(firstReport.id).toBe(reportId);
      expect(firstReport.missingCardIds).toEqual([unknownCardId]);

      const row = await prisma.shiftExitReport.findUnique({
        where: { id: reportId },
      });
      expect(row).not.toBeNull();

      const after = await countObjectsWithPrefix(
        rawS3,
        TEST_BUCKET,
        'reports/shift-exit/',
      );
      expect(after).toBe(before + 1);
    });

    it('REPLAY -> el mismo reporte, sin objeto nuevo', async () => {
      const before = await countObjectsWithPrefix(
        rawS3,
        TEST_BUCKET,
        'reports/shift-exit/',
      );

      const response = await supervisorAgent
        .post('/api/shift-reports')
        .send({
          id: reportId,
          shiftDate: todayShiftDate,
          shiftType: 'NOCTURNO',
          cardIds: [cardId, unknownCardId],
          requestedAt: new Date().toISOString(),
        })
        .expect(201);

      const replayed = (response.body as ApiEnvelope<ShiftReportData>).data;
      expect(replayed.id).toBe(firstReport.id);
      expect(replayed.createdAt).toBe(firstReport.createdAt);

      const after = await countObjectsWithPrefix(
        rawS3,
        TEST_BUCKET,
        'reports/shift-exit/',
      );
      expect(after).toBe(before);
    });

    it('GET .../file -> 302 a una URL firmada que devuelve el PDF', async () => {
      const redirectResponse = await supervisorAgent
        .get(`/api/shift-reports/${reportId}/file`)
        .redirects(0)
        .expect(302);

      const location: string = redirectResponse.headers.location;
      expect(location).toBeTruthy();

      const fetched = await fetch(location);
      expect(fetched.status).toBe(200);
      const bytes = Buffer.from(await fetched.arrayBuffer());
      expect(bytes.subarray(0, 4).toString('utf8')).toBe('%PDF');
    });

    it('tras el listener (poll), hay notificación ADMIN y emailStatus ya no es PENDING', async () => {
      const notification = await waitFor(
        () =>
          prisma.notification.findFirst({
            where: {
              tipo: DOMAIN_EVENTS.SHIFT_EXIT_REPORT_SENT,
              userId: adminUserId,
              data: { path: ['reportId'], equals: reportId },
            },
          }),
        'notificación ADMIN de shift.exit-report',
      );
      expect(notification.titulo).toContain('Reporte de salida de turno');

      const report = await waitFor(async () => {
        const row = await prisma.shiftExitReport.findUnique({
          where: { id: reportId },
        });
        return row && row.emailStatus !== 'PENDING' ? row : null;
      }, 'emailStatus fuera de PENDING');
      expect(report.emailStatus).not.toBe('PENDING');
    });
  });

  describe('7) Mis tarjetas — visibilidad por rol', () => {
    it('supervisor A ve su propia tarjeta en /mine; supervisor B no', async () => {
      const asA = await supervisorAgent
        .get('/api/shift-cards/mine')
        .expect(200);
      const cardsA = (asA.body as ApiEnvelope<ShiftCardData[]>).data;
      expect(cardsA.some((card) => card.id === flow2CardId)).toBe(true);

      const asB = await supervisorBAgent
        .get('/api/shift-cards/mine')
        .expect(200);
      const cardsB = (asB.body as ApiEnvelope<ShiftCardData[]>).data;
      expect(cardsB.some((card) => card.id === flow2CardId)).toBe(false);
    });
  });

  describe('8) Rol MANTENEDOR — sin acceso', () => {
    it('POST /api/shift-cards -> 403', async () => {
      await mantenedorAgent
        .post('/api/shift-cards')
        .send({
          id: randomUUID(),
          equipoId: flow2Equipo.id,
          operatorId,
          valorInicial: 1,
          shiftDate: todayShiftDate,
          shiftType: 'DIURNO',
          capturedAt: new Date().toISOString(),
        })
        .expect(403);
    });

    it('POST /api/shift-reports -> 403', async () => {
      await mantenedorAgent
        .post('/api/shift-reports')
        .send({
          id: randomUUID(),
          shiftDate: todayShiftDate,
          shiftType: 'DIURNO',
          cardIds: [randomUUID()],
          requestedAt: new Date().toISOString(),
        })
        .expect(403);
    });

    it('POST /api/equipment -> 403', async () => {
      await mantenedorAgent
        .post('/api/equipment')
        .send(baseEquipmentPayload(internalCode('MANTENEDOR')))
        .expect(403);
    });
  });

  describe('9) PATCH /api/equipment/:id/assignment — operadores del catálogo', () => {
    let equipo: EquipmentData;
    let operadorActivoId: string;
    let operadorInactivoId: string;
    const operadoresParaLimpiar: string[] = [];

    it('crea el equipo y los operadores fresh para este flujo', async () => {
      const response = await adminAgent
        .post('/api/equipment')
        .send(baseEquipmentPayload(internalCode('ASIGNACION')))
        .expect(201);
      equipo = (response.body as ApiEnvelope<EquipmentData>).data;
      createdEquipmentIds.push(equipo.id);

      const activoResponse = await adminAgent
        .post('/api/operators')
        .send({ name: `Operador Activo E2E ${RUN_ID}` })
        .expect(201);
      operadorActivoId = (activoResponse.body as ApiEnvelope<OperatorData>).data
        .id;
      operadoresParaLimpiar.push(operadorActivoId);

      const inactivoResponse = await adminAgent
        .post('/api/operators')
        .send({ name: `Operador Inactivo E2E ${RUN_ID}`, isActive: false })
        .expect(201);
      operadorInactivoId = (inactivoResponse.body as ApiEnvelope<OperatorData>)
        .data.id;
      operadoresParaLimpiar.push(operadorInactivoId);
    });

    it('asigna un operador ACTIVO del catálogo -> 200 con {operator:{id,name}, inUse:true}', async () => {
      const response = await supervisorAgent
        .patch(`/api/equipment/${equipo.id}/assignment`)
        .send({ operatorId: operadorActivoId })
        .expect(200);
      const data = (response.body as ApiEnvelope<EquipmentData>).data;

      expect(data.operator).toMatchObject({ id: operadorActivoId });
      expect(data.inUse).toBe(true);
    });

    it('asignar un operador INACTIVO -> 409 OPERATOR_INACTIVE', async () => {
      const response = await supervisorAgent
        .patch(`/api/equipment/${equipo.id}/assignment`)
        .send({ operatorId: operadorInactivoId })
        .expect(409);

      expect((response.body as ErrorEnvelope).code).toBe('OPERATOR_INACTIVE');
    });

    it('asignar un id de USER (no de Operator) -> 404', async () => {
      await supervisorAgent
        .patch(`/api/equipment/${equipo.id}/assignment`)
        .send({ operatorId: adminUserId })
        .expect(404);
    });

    it('liberar con null -> inUse false', async () => {
      const response = await supervisorAgent
        .patch(`/api/equipment/${equipo.id}/assignment`)
        .send({ operatorId: null })
        .expect(200);
      const data = (response.body as ApiEnvelope<EquipmentData>).data;

      expect(data.operator).toBeNull();
      expect(data.inUse).toBe(false);
    });

    it('borrar un operador ASIGNADO a un equipo -> 409 OPERATOR_IN_USE', async () => {
      await supervisorAgent
        .patch(`/api/equipment/${equipo.id}/assignment`)
        .send({ operatorId: operadorActivoId })
        .expect(200);

      const response = await adminAgent
        .delete(`/api/operators/${operadorActivoId}`)
        .expect(409);

      expect((response.body as ErrorEnvelope).code).toBe('OPERATOR_IN_USE');

      // Desasigna para poder limpiar el operador en el afterAll de esta
      // sección, siguiendo el mismo patrón "vía API real" del resto del
      // archivo.
      await supervisorAgent
        .patch(`/api/equipment/${equipo.id}/assignment`)
        .send({ operatorId: null })
        .expect(200);
    });

    afterAll(async () => {
      for (const idParaBorrar of operadoresParaLimpiar) {
        await adminAgent.delete(`/api/operators/${idParaBorrar}`).expect(200);
      }
    });
  });
});
