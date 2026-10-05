/**
 * Prueba e2e de las escrituras de oficina que la cola offline reintenta:
 * creates idempotentes por id del cliente, movimientos de stock sin duplicar,
 * precondición por campo (`X-Expected`) en los PATCH, y cierre de turno de
 * Flota con `closeClientId`. App Nest real (mismo pipeline que `main.ts`),
 * Postgres y MinIO REALES.
 *
 * Todo lo que el test crea lleva el id del run en el código/nombre, así un
 * rerun no choca con una corrida anterior.
 *
 * Se salta completo (`describe.skip`) si MinIO o Postgres no están arriba.
 */
import { randomUUID } from 'node:crypto';

import { isMinioReachable, isPostgresReachable } from './helpers/reachability';

const minioReachable = isMinioReachable();
const postgresReachable = isPostgresReachable();

const TEST_BUCKET = 'smi-office-offline-e2e';
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
import {
  DEFAULT_DEV_STORAGE_ACCESS_KEY_ID,
  DEFAULT_DEV_STORAGE_SECRET_ACCESS_KEY,
} from '../src/common/config/env';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ApiEnvelope, ErrorEnvelope } from './helpers/api-envelope';
import { expectNoCreatedById } from './helpers/assert-no-internal-fields';
import { bootstrapApp } from './helpers/bootstrap-app';
import {
  baseEquipmentPayload,
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
    `office-offline-writes.e2e-spec: SALTEADO (MinIO reachable=${minioReachable}, ` +
      `Postgres reachable=${postgresReachable}) — levantar con ` +
      '"docker compose up -d minio minio-init smi-postgres"',
  );
}

const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
]);

interface IdData {
  id: string;
  [key: string]: unknown;
}
interface UploadFileData {
  key: string;
  url: string;
}
interface UserData {
  id: string;
  email: string;
}
interface StockRow {
  branchId: string;
  quantity: number;
}
interface ItemData extends IdData {
  stocks: StockRow[];
}
interface MovementData extends IdData {
  resultingBalance: number;
}
interface TransferData {
  reference: string;
  out: IdData;
  in: IdData;
  sourceBranchName: string;
  destinationBranchName: string;
}
interface AdjustData {
  item: IdData;
  movement: IdData | null;
}

/** El header `X-Expected` viaja como `encodeURIComponent(JSON)`: los valores
 * con tildes, «—» o comillas tipográficas no son Latin-1 y el navegador los
 * rechazaría crudos. */
function expectedHeader(expected: Record<string, unknown>): string {
  return encodeURIComponent(JSON.stringify(expected));
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

async function listKeys(client: S3Client, bucket: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of listed.Contents ?? []) {
      if (object.Key) keys.push(object.Key);
    }
    continuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return keys;
}

async function deleteAllObjects(
  client: S3Client,
  bucket: string,
): Promise<void> {
  for (const key of await listKeys(client, bucket)) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  description: string,
  timeoutMs = 5000,
  intervalMs = 150,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor: tiempo de espera agotado (${description})`);
}

maybeDescribe('Escrituras de oficina reintentables (e2e)', () => {
  jest.setTimeout(60_000);

  let app: NestExpressApplication;
  let prisma: PrismaService;
  let rawS3: S3Client;

  let adminAgent: SupertestAgent;
  let adminBAgent: SupertestAgent;
  let supervisorAgent: SupertestAgent;
  let supervisorBAgent: SupertestAgent;
  let mantenedorAgent: SupertestAgent;

  const extraUserIds: string[] = [];

  // `internalCode` tiene @MaxLength(20) — "OW-" (3) + RUN_ID (5) + "-NN".
  const RUN_ID = randomUUID().slice(0, 5).toUpperCase();
  let codeSeq = 0;
  const nextCode = () => `OW-${RUN_ID}-${++codeSeq}`;

  const equipmentIds: string[] = [];
  const itemIds: string[] = [];
  const categoryIds: string[] = [];
  const branchIds: string[] = [];
  const operatorIds: string[] = [];
  const ordenIds: string[] = [];
  const actividadIds: string[] = [];
  const umbralIds: string[] = [];

  async function createUser(
    role: string,
    label: string,
  ): Promise<{ agent: SupertestAgent; id: string }> {
    const response = await adminAgent
      .post('/api/users')
      .send({
        name: `${label} (e2e offline)`,
        email: `${label}-${RUN_ID}@e2e.smi.local`,
        password: SEED_PASSWORD,
        role,
      })
      .expect(201);
    const user = (response.body as ApiEnvelope<UserData>).data;
    extraUserIds.push(user.id);
    return {
      agent: await loginAgent(app, user.email, SEED_PASSWORD),
      id: user.id,
    };
  }

  async function newEquipment(
    overrides: Record<string, unknown> = {},
  ): Promise<IdData & { internalCode: string }> {
    const payload = {
      id: randomUUID(),
      ...baseEquipmentPayload(nextCode()),
      ...overrides,
    };
    const response = await adminAgent
      .post('/api/equipment')
      .send(payload)
      .expect(201);
    equipmentIds.push(payload.id);
    return (response.body as ApiEnvelope<IdData & { internalCode: string }>)
      .data;
  }

  async function newBranch(name: string): Promise<IdData> {
    const id = randomUUID();
    const response = await adminAgent
      .post('/api/branches')
      .send({ id, name: `${name} ${RUN_ID}` })
      .expect(201);
    branchIds.push(id);
    return (response.body as ApiEnvelope<IdData>).data;
  }

  async function newItem(
    branchId: string,
    quantity: number,
  ): Promise<ItemData> {
    const id = randomUUID();
    const response = await adminAgent
      .post('/api/inventory/items')
      .send({
        id,
        sku: `OW${RUN_ID}${++codeSeq}`.toUpperCase(),
        name: `Ítem e2e ${RUN_ID}`,
        initialQuantity: quantity,
        branchId,
      })
      .expect(201);
    itemIds.push(id);
    return (response.body as ApiEnvelope<ItemData>).data;
  }

  async function newOperator(): Promise<OperatorData> {
    const id = randomUUID();
    const response = await adminAgent
      .post('/api/operators')
      .send({ id, name: `Operador e2e ${RUN_ID}` })
      .expect(201);
    operatorIds.push(id);
    return (response.body as ApiEnvelope<OperatorData>).data;
  }

  async function balanceOf(itemId: string, branchId: string): Promise<number> {
    const stock = await prisma.stock.findUnique({
      where: { itemId_branchId: { itemId, branchId } },
    });
    return stock?.quantity ?? 0;
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
    ({ agent: adminBAgent } = await createUser(ROLES.ADMIN, 'admin-b'));
    ({ agent: supervisorBAgent } = await createUser(
      ROLES.SUPERVISOR,
      'supervisor-b',
    ));
  });

  afterAll(async () => {
    const equipmentFilter = { equipoId: { in: equipmentIds } };
    await prisma.registroCombustible.deleteMany({ where: equipmentFilter });
    await prisma.registroHorometro.deleteMany({ where: equipmentFilter });
    await prisma.intervencion.deleteMany({
      where: { ordenId: { in: ordenIds } },
    });
    await prisma.ordenTrabajo.deleteMany({ where: { id: { in: ordenIds } } });
    await prisma.actividad.deleteMany({ where: { id: { in: actividadIds } } });
    await prisma.umbralMantenimiento.deleteMany({
      where: { id: { in: umbralIds } },
    });
    await prisma.notification.deleteMany({
      where: {
        OR: itemIds.map((id) => ({ data: { path: ['itemId'], equals: id } })),
      },
    });
    await prisma.stockMovement.deleteMany({
      where: {
        OR: [{ itemId: { in: itemIds } }, { branchId: { in: branchIds } }],
      },
    });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.itemCategory.deleteMany({
      where: { id: { in: categoryIds } },
    });
    await prisma.equipment.deleteMany({ where: { id: { in: equipmentIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
    await prisma.operator.deleteMany({ where: { id: { in: operatorIds } } });
    for (const userId of extraUserIds) {
      await adminAgent.delete(`/api/users/${userId}`);
    }

    await deleteAllObjects(rawS3, TEST_BUCKET);
    await app.close();
  });

  // ---------------------------------------------------------------------
  describe('Equipo: create idempotente', () => {
    it('el reintento con el mismo id devuelve la misma fila y deja UN solo registro', async () => {
      const payload = { id: randomUUID(), ...baseEquipmentPayload(nextCode()) };
      equipmentIds.push(payload.id);

      const first = await adminAgent
        .post('/api/equipment')
        .send(payload)
        .expect(201);
      const replay = await adminAgent
        .post('/api/equipment')
        .send(payload)
        .expect(201);

      const firstData = (first.body as ApiEnvelope<IdData>).data;
      const replayData = (replay.body as ApiEnvelope<IdData>).data;
      expect(replayData.id).toBe(firstData.id);
      expect(replayData.internalCode).toBe(payload.internalCode);
      expect('createdById' in replayData).toBe(false);
      expect(await prisma.equipment.count({ where: { id: payload.id } })).toBe(
        1,
      );
      const row = await prisma.equipment.findUniqueOrThrow({
        where: { id: payload.id },
        select: { createdById: true },
      });
      expect(row.createdById).not.toBeNull();
    });

    it('otro usuario con el mismo id -> 409 ID_CONFLICT y no pisa la fila', async () => {
      const payload = { id: randomUUID(), ...baseEquipmentPayload(nextCode()) };
      equipmentIds.push(payload.id);
      await adminAgent.post('/api/equipment').send(payload).expect(201);

      const response = await adminBAgent
        .post('/api/equipment')
        .send({ ...payload, brand: 'Otra marca' })
        .expect(409);

      expect((response.body as ErrorEnvelope).code).toBe('ID_CONFLICT');
      const row = await prisma.equipment.findUniqueOrThrow({
        where: { id: payload.id },
      });
      expect(row.brand).toBe(payload.brand);
    });

    it('internalCode duplicado con OTRO id -> el 409 de siempre, no ID_CONFLICT', async () => {
      const original = await newEquipment();

      const response = await adminAgent
        .post('/api/equipment')
        .send({
          id: randomUUID(),
          ...baseEquipmentPayload(original.internalCode),
        })
        .expect(409);

      const body = response.body as ErrorEnvelope;
      expect(body.code).toBeUndefined();
      expect(body.message).toContain(original.internalCode);
    });

    it('dos requests simultáneas con el mismo id y el mismo código: ambas responden la misma fila (el P2002 de la PK es la carrera, meta.target = [id])', async () => {
      const payload = { id: randomUUID(), ...baseEquipmentPayload(nextCode()) };
      equipmentIds.push(payload.id);

      const [a, b] = await Promise.all([
        adminAgent.post('/api/equipment').send(payload),
        adminAgent.post('/api/equipment').send(payload),
      ]);

      expect([a.status, b.status]).toEqual([201, 201]);
      expect((a.body as ApiEnvelope<IdData>).data.id).toBe(payload.id);
      expect((b.body as ApiEnvelope<IdData>).data.id).toBe(payload.id);
      expect(await prisma.equipment.count({ where: { id: payload.id } })).toBe(
        1,
      );
    });

    it('con foto: el reintento no reclama otra vez y deja UN solo objeto', async () => {
      const upload = await adminAgent
        .post('/api/files')
        .attach('file', MINIMAL_JPEG, 'equipo.jpg')
        .expect(201);
      const { key } = (upload.body as ApiEnvelope<UploadFileData>).data;
      const payload = {
        id: randomUUID(),
        ...baseEquipmentPayload(nextCode()),
        photoKey: key,
      };
      equipmentIds.push(payload.id);

      await adminAgent.post('/api/equipment').send(payload).expect(201);
      const replay = await adminAgent
        .post('/api/equipment')
        .send(payload)
        .expect(201);

      expect(
        (replay.body as ApiEnvelope<{ photoUrl: string | null }>).data.photoUrl,
      ).toEqual(expect.stringContaining('http'));
      const finals = (await listKeys(rawS3, TEST_BUCKET)).filter((k) =>
        k.startsWith('equipment-photos/'),
      );
      const row = await prisma.equipment.findUniqueOrThrow({
        where: { id: payload.id },
      });
      expect(finals.filter((k) => k === row.photoKey)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  describe('Catálogos y documentos: create idempotente', () => {
    it('sucursal, categoría, operador: replay devuelve la misma fila sin duplicar', async () => {
      const branch = await newBranch('Replay');
      const branchReplay = await adminAgent
        .post('/api/branches')
        .send({ id: branch.id, name: `Replay ${RUN_ID}` })
        .expect(201);
      expect((branchReplay.body as ApiEnvelope<IdData>).data.id).toBe(
        branch.id,
      );

      const categoryId = randomUUID();
      categoryIds.push(categoryId);
      const categoryPayload = { id: categoryId, name: `Cat ${RUN_ID}` };
      await adminAgent
        .post('/api/inventory/categories')
        .send(categoryPayload)
        .expect(201);
      await adminAgent
        .post('/api/inventory/categories')
        .send(categoryPayload)
        .expect(201);
      expect(
        await prisma.itemCategory.count({ where: { id: categoryId } }),
      ).toBe(1);

      const operator = await newOperator();
      await adminAgent
        .post('/api/operators')
        .send({ id: operator.id, name: `Operador e2e ${RUN_ID}` })
        .expect(201);
      expect(await prisma.operator.count({ where: { id: operator.id } })).toBe(
        1,
      );
    });

    it('nombre de sucursal repetido con otro id -> 409 sin ID_CONFLICT', async () => {
      const branch = await newBranch('Dup');

      const response = await adminAgent
        .post('/api/branches')
        .send({ id: randomUUID(), name: `Dup ${RUN_ID}` })
        .expect(409);

      expect((response.body as ErrorEnvelope).code).toBeUndefined();
      expect(branch.id).toBeDefined();
    });

    it('documento del equipo con archivo: replay sin reclamar otra vez', async () => {
      const equipo = await newEquipment();
      const upload = await supervisorAgent
        .post('/api/files')
        .attach('file', MINIMAL_JPEG, 'seguro.jpg')
        .expect(201);
      const { key } = (upload.body as ApiEnvelope<UploadFileData>).data;
      const payload = { id: randomUUID(), type: 'INSURANCE', fileKey: key };

      await supervisorAgent
        .post(`/api/equipment/${equipo.id}/documents`)
        .send(payload)
        .expect(201);
      const replay = await supervisorAgent
        .post(`/api/equipment/${equipo.id}/documents`)
        .send(payload)
        .expect(201);

      expect((replay.body as ApiEnvelope<IdData>).data.id).toBe(payload.id);
      expect(
        await prisma.equipmentDocument.count({ where: { id: payload.id } }),
      ).toBe(1);

      const other = await supervisorBAgent
        .post(`/api/equipment/${equipo.id}/documents`)
        .send({ id: payload.id, type: 'INSURANCE' })
        .expect(409);
      expect((other.body as ErrorEnvelope).code).toBe('ID_CONFLICT');
    });

    it('mantenimiento: orden (con tareas), intervención, actividad y umbral son reintentables', async () => {
      const equipo = await newEquipment();

      const ordenPayload = {
        id: randomUUID(),
        equipoId: equipo.id,
        titulo: `Orden e2e ${RUN_ID}`,
        tareas: [{ texto: 'Revisar frenos' }],
      };
      ordenIds.push(ordenPayload.id);
      await adminAgent
        .post('/api/mantenimiento/ordenes')
        .send(ordenPayload)
        .expect(201);
      await adminAgent
        .post('/api/mantenimiento/ordenes')
        .send(ordenPayload)
        .expect(201);
      expect(
        await prisma.ordenTrabajo.count({ where: { id: ordenPayload.id } }),
      ).toBe(1);
      expect(
        await prisma.tareaOT.count({ where: { ordenId: ordenPayload.id } }),
      ).toBe(1);

      const intervencionPayload = {
        id: randomUUID(),
        tipo: 'CORRECTIVA',
        detalle: 'Cambio de balatas',
        insumos: [{ insumoId: 'ORG-008', cantidad: 2 }],
      };
      await mantenedorAgent
        .post(`/api/mantenimiento/ordenes/${ordenPayload.id}/intervenciones`)
        .send(intervencionPayload)
        .expect(201);
      await mantenedorAgent
        .post(`/api/mantenimiento/ordenes/${ordenPayload.id}/intervenciones`)
        .send(intervencionPayload)
        .expect(201);
      expect(
        await prisma.intervencion.count({
          where: { id: intervencionPayload.id },
        }),
      ).toBe(1);
      expect(
        await prisma.intervencionInsumo.count({
          where: { intervencionId: intervencionPayload.id },
        }),
      ).toBe(1);

      const actividadPayload = {
        id: randomUUID(),
        descripcion: `Actividad e2e ${RUN_ID}`,
        origen: 'MANUAL',
      };
      actividadIds.push(actividadPayload.id);
      await adminAgent
        .post('/api/mantenimiento/actividades')
        .send(actividadPayload)
        .expect(201);
      await adminAgent
        .post('/api/mantenimiento/actividades')
        .send(actividadPayload)
        .expect(201);
      expect(
        await prisma.actividad.count({ where: { id: actividadPayload.id } }),
      ).toBe(1);

      const umbralPayload = {
        id: randomUUID(),
        tipoEquipo: `Tipo ${RUN_ID}`,
        tipoMantencion: 'Mantención 250 h',
        umbralHoras: 250,
      };
      umbralIds.push(umbralPayload.id);
      await adminAgent
        .post('/api/mantenimiento/umbrales')
        .send(umbralPayload)
        .expect(201);
      await adminAgent
        .post('/api/mantenimiento/umbrales')
        .send(umbralPayload)
        .expect(201);
      expect(
        await prisma.umbralMantenimiento.count({
          where: { id: umbralPayload.id },
        }),
      ).toBe(1);

      const conflict = await supervisorAgent
        .post('/api/mantenimiento/ordenes')
        .send({ ...ordenPayload, titulo: 'Otra' })
        .expect(409);
      expect((conflict.body as ErrorEnvelope).code).toBe('ID_CONFLICT');
    });
  });

  // ---------------------------------------------------------------------
  describe('Stock', () => {
    it('ítem con existencia inicial: el replay NO vuelve a recibirla', async () => {
      const branch = await newBranch('Stock A');
      const item = await newItem(branch.id, 40);

      await adminAgent
        .post('/api/inventory/items')
        .send({
          id: item.id,
          sku: 'IGNORADO',
          name: 'Ignorado',
          initialQuantity: 40,
          branchId: branch.id,
        })
        .expect(201);

      expect(await balanceOf(item.id, branch.id)).toBe(40);
      expect(
        await prisma.stockMovement.count({ where: { itemId: item.id } }),
      ).toBe(1);
    });

    it('salida: el reintento con el mismo id baja el saldo UNA sola vez, devuelve el mismo asiento y avisa de existencia baja UNA vez', async () => {
      const branch = await newBranch('Stock B');
      const item = await newItem(branch.id, 100);
      await adminAgent
        .put('/api/inventory/stock/minimum')
        .send({ itemId: item.id, branchId: branch.id, minimumQuantity: 95 })
        .expect(200);
      const payload = {
        id: randomUUID(),
        itemId: item.id,
        branchId: branch.id,
        direction: 'OUT',
        reason: 'INTERVENTION',
        quantity: 10,
      };

      const first = await adminAgent
        .post('/api/inventory/movements')
        .send(payload);
      const replay = await adminAgent
        .post('/api/inventory/movements')
        .send(payload);

      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      const firstData = (first.body as ApiEnvelope<MovementData>).data;
      const replayData = (replay.body as ApiEnvelope<MovementData>).data;
      expect(replayData.id).toBe(payload.id);
      expect(replayData.resultingBalance).toBe(firstData.resultingBalance);
      expect(await balanceOf(item.id, branch.id)).toBe(90);
      expect(
        await prisma.stockMovement.count({ where: { id: payload.id } }),
      ).toBe(1);

      const countLowStock = () =>
        prisma.notification.count({
          where: { data: { path: ['itemId'], equals: item.id } },
        });
      // El aviso se reparte a un registro por usuario de los roles que lo
      // reciben: lo que no puede pasar es que el reintento reparta otra tanda.
      const delivered = await waitFor(async () => {
        const count = await countLowStock();
        return count > 0 ? count : null;
      }, 'notificación de existencia baja');
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(await countLowStock()).toBe(delivered);
    });

    it('salida sin existencia suficiente -> 409 INSUFFICIENT_STOCK con el mensaje claro', async () => {
      const branch = await newBranch('Stock C');
      const item = await newItem(branch.id, 5);

      const response = await adminAgent
        .post('/api/inventory/movements')
        .send({
          id: randomUUID(),
          itemId: item.id,
          branchId: branch.id,
          direction: 'OUT',
          reason: 'INTERVENTION',
          quantity: 50,
        })
        .expect(409);

      const body = response.body as ErrorEnvelope;
      expect(body.code).toBe('INSUFFICIENT_STOCK');
      expect(body.message).toContain('Existencia insuficiente');
      expect(await balanceOf(item.id, branch.id)).toBe(5);
    });

    it('movimiento con id de otro usuario -> 409 ID_CONFLICT y no mueve saldo', async () => {
      const branch = await newBranch('Stock D');
      const item = await newItem(branch.id, 20);
      const payload = {
        id: randomUUID(),
        itemId: item.id,
        branchId: branch.id,
        direction: 'OUT',
        reason: 'INTERVENTION',
        quantity: 1,
      };
      await adminAgent
        .post('/api/inventory/movements')
        .send(payload)
        .expect(201);

      const response = await adminBAgent
        .post('/api/inventory/movements')
        .send(payload)
        .expect(409);

      expect((response.body as ErrorEnvelope).code).toBe('ID_CONFLICT');
      expect(await balanceOf(item.id, branch.id)).toBe(19);
    });

    it('traspaso: el reintento con el mismo id mueve el saldo UNA vez y responde lo mismo', async () => {
      const origin = await newBranch('Origen');
      const destination = await newBranch('Destino');
      const item = await newItem(origin.id, 50);
      const payload = {
        id: randomUUID(),
        itemId: item.id,
        sourceBranchId: origin.id,
        destinationBranchId: destination.id,
        quantity: 12,
      };

      const first = await supervisorAgent
        .post('/api/inventory/stock/transfer')
        .send(payload)
        .expect(201);
      const replay = await supervisorAgent
        .post('/api/inventory/stock/transfer')
        .send(payload)
        .expect(201);

      const a = (first.body as ApiEnvelope<TransferData>).data;
      const b = (replay.body as ApiEnvelope<TransferData>).data;
      expect(a.reference).toBe(`transfer_${payload.id}`);
      expect(b.reference).toBe(a.reference);
      expect(b.out.id).toBe(payload.id);
      expect(b.in.id).toBe(a.in.id);
      expect(b.sourceBranchName).toBe(a.sourceBranchName);
      expect(b.destinationBranchName).toBe(a.destinationBranchName);
      expect(await balanceOf(item.id, origin.id)).toBe(38);
      expect(await balanceOf(item.id, destination.id)).toBe(12);

      const other = await supervisorBAgent
        .post('/api/inventory/stock/transfer')
        .send(payload)
        .expect(409);
      expect((other.body as ErrorEnvelope).code).toBe('ID_CONFLICT');
    });

    it('traspaso sin existencia -> 409 INSUFFICIENT_STOCK', async () => {
      const origin = await newBranch('Origen2');
      const destination = await newBranch('Destino2');
      const item = await newItem(origin.id, 3);

      const response = await supervisorAgent
        .post('/api/inventory/stock/transfer')
        .send({
          id: randomUUID(),
          itemId: item.id,
          sourceBranchId: origin.id,
          destinationBranchId: destination.id,
          quantity: 30,
        })
        .expect(409);

      expect((response.body as ErrorEnvelope).code).toBe('INSUFFICIENT_STOCK');
    });

    it('conteo físico: replay con el mismo id deja UN asiento; expectedQuantity vencida -> 409 STALE_UPDATE', async () => {
      const branch = await newBranch('Conteo');
      const item = await newItem(branch.id, 30);
      const payload = {
        id: randomUUID(),
        branchId: branch.id,
        countedQuantity: 25,
        expectedQuantity: 30,
      };

      const first = await adminAgent
        .post(`/api/inventory/items/${item.id}/adjust`)
        .send(payload)
        .expect(201);
      const replay = await adminAgent
        .post(`/api/inventory/items/${item.id}/adjust`)
        .send(payload)
        .expect(201);

      expect((first.body as ApiEnvelope<AdjustData>).data.movement?.id).toBe(
        payload.id,
      );
      expect((replay.body as ApiEnvelope<AdjustData>).data.movement?.id).toBe(
        payload.id,
      );
      expect(await balanceOf(item.id, branch.id)).toBe(25);
      expect(
        await prisma.stockMovement.count({ where: { id: payload.id } }),
      ).toBe(1);

      // Alguien movió stock mientras otro contaba: veía 25 y ahora hay 20.
      await adminAgent
        .post('/api/inventory/movements')
        .send({
          itemId: item.id,
          branchId: branch.id,
          direction: 'OUT',
          reason: 'INTERVENTION',
          quantity: 5,
        })
        .expect(201);
      const stale = await adminAgent
        .post(`/api/inventory/items/${item.id}/adjust`)
        .send({
          id: randomUUID(),
          branchId: branch.id,
          countedQuantity: 22,
          expectedQuantity: 25,
        })
        .expect(409);

      expect((stale.body as ErrorEnvelope).code).toBe('STALE_UPDATE');
      expect(await balanceOf(item.id, branch.id)).toBe(20);
    });

    it('conteo que coincide con el sistema: sin movimiento', async () => {
      const branch = await newBranch('Conteo igual');
      const item = await newItem(branch.id, 10);

      const response = await adminAgent
        .post(`/api/inventory/items/${item.id}/adjust`)
        .send({ id: randomUUID(), branchId: branch.id, countedQuantity: 10 })
        .expect(201);

      expect(
        (response.body as ApiEnvelope<AdjustData>).data.movement,
      ).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  describe('Flota: horómetro entrada/salida', () => {
    it('entrada: replay con el mismo id devuelve el registro y capturedAt es la fecha', async () => {
      const equipo = await newEquipment();
      const operator = await newOperator();
      const capturedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
      const payload = {
        id: randomUUID(),
        equipoId: equipo.id,
        operatorId: operator.id,
        turno: 'DIURNO',
        valorInicial: 100,
        capturedAt,
      };

      const first = await supervisorAgent
        .post('/api/horometro')
        .send(payload)
        .expect(201);
      const replay = await supervisorAgent
        .post('/api/horometro')
        .send(payload)
        .expect(201);

      const a = (first.body as ApiEnvelope<IdData & { fecha: string }>).data;
      const b = (replay.body as ApiEnvelope<IdData & { fecha: string }>).data;
      expect(b.id).toBe(a.id);
      expect(new Date(a.fecha).toISOString()).toBe(capturedAt);
      expect(
        await prisma.registroHorometro.count({ where: { id: payload.id } }),
      ).toBe(1);

      const other = await supervisorBAgent
        .post('/api/horometro')
        .send(payload)
        .expect(409);
      expect((other.body as ErrorEnvelope).code).toBe('ID_CONFLICT');
    });

    it('entrada con el equipo ya en turno -> 400 con code EQUIPMENT_BUSY', async () => {
      const equipo = await newEquipment();
      const operator = await newOperator();
      const base = {
        equipoId: equipo.id,
        operatorId: operator.id,
        turno: 'DIURNO',
        valorInicial: 10,
      };
      await supervisorAgent
        .post('/api/horometro')
        .send({ id: randomUUID(), ...base })
        .expect(201);

      const response = await supervisorAgent
        .post('/api/horometro')
        .send({ id: randomUUID(), ...base })
        .expect(400);

      expect((response.body as ErrorEnvelope).code).toBe('EQUIPMENT_BUSY');
    });

    it('salida: el reintento con el mismo closeClientId responde 200 con la tarjeta; otro id -> 409 ALREADY_CLOSED', async () => {
      const equipo = await newEquipment();
      const operator = await newOperator();
      const entrada = await supervisorAgent
        .post('/api/horometro')
        .send({
          id: randomUUID(),
          equipoId: equipo.id,
          operatorId: operator.id,
          turno: 'NOCTURNO',
          valorInicial: 200,
        })
        .expect(201);
      const registroId = (entrada.body as ApiEnvelope<IdData>).data.id;
      const closeClientId = randomUUID();
      const capturedAt = new Date(Date.now() - 3_600_000).toISOString();

      const first = await supervisorAgent
        .patch(`/api/horometro/${registroId}/salida`)
        .send({ valorFinal: 215, closeClientId, capturedAt })
        .expect(200);
      const replay = await supervisorAgent
        .patch(`/api/horometro/${registroId}/salida`)
        .send({ valorFinal: 215, closeClientId, capturedAt })
        .expect(200);

      const a = (first.body as ApiEnvelope<IdData & { fechaSalida: string }>)
        .data;
      const b = (replay.body as ApiEnvelope<IdData & { fechaSalida: string }>)
        .data;
      expect(b.id).toBe(a.id);
      expect(new Date(a.fechaSalida).toISOString()).toBe(capturedAt);
      expect('closeClientId' in b).toBe(false);

      const closedAgain = await supervisorAgent
        .patch(`/api/horometro/${registroId}/salida`)
        .send({ valorFinal: 215, closeClientId: randomUUID() })
        .expect(409);
      expect((closedAgain.body as ErrorEnvelope).code).toBe('ALREADY_CLOSED');

      const row = await prisma.registroHorometro.findUniqueOrThrow({
        where: { id: registroId },
      });
      expect(row.closeClientId).toBe(closeClientId);
      expect(row.valorFinal).toBe(215);
    });

    it('salida con lectura menor a la inicial -> 400 HOURMETER_BELOW_INITIAL; id inexistente -> 404 CARD_NOT_FOUND', async () => {
      const equipo = await newEquipment();
      const operator = await newOperator();
      const entrada = await supervisorAgent
        .post('/api/horometro')
        .send({
          id: randomUUID(),
          equipoId: equipo.id,
          operatorId: operator.id,
          turno: 'DIURNO',
          valorInicial: 300,
        })
        .expect(201);
      const registroId = (entrada.body as ApiEnvelope<IdData>).data.id;

      const below = await supervisorAgent
        .patch(`/api/horometro/${registroId}/salida`)
        .send({ valorFinal: 10 })
        .expect(400);
      expect((below.body as ErrorEnvelope).code).toBe(
        'HOURMETER_BELOW_INITIAL',
      );

      const missing = await supervisorAgent
        .patch(`/api/horometro/${randomUUID()}/salida`)
        .send({ valorFinal: 500 })
        .expect(404);
      expect((missing.body as ErrorEnvelope).code).toBe('CARD_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------
  describe('Combustible con foto', () => {
    it('replay con el mismo id: la foto se reclama UNA vez (un solo objeto) y se firma de nuevo', async () => {
      const equipo = await newEquipment();
      const upload = await supervisorAgent
        .post('/api/files')
        .attach('file', MINIMAL_JPEG, 'surtidor.jpg')
        .expect(201);
      const { key } = (upload.body as ApiEnvelope<UploadFileData>).data;
      const payload = {
        id: randomUUID(),
        equipoId: equipo.id,
        litros: 40,
        tipo: 'PETROLEO',
        fotoKey: key,
      };

      const first = await supervisorAgent
        .post('/api/combustible')
        .send(payload)
        .expect(201);
      const replay = await supervisorAgent
        .post('/api/combustible')
        .send(payload)
        .expect(201);

      const a = (first.body as ApiEnvelope<IdData & { fotoUrl: string }>).data;
      const b = (replay.body as ApiEnvelope<IdData & { fotoUrl: string }>).data;
      expect(b.id).toBe(a.id);
      expect(b.fotoUrl).toEqual(expect.stringContaining('http'));
      expect('fotoKey' in b).toBe(false);
      expect('createdById' in b).toBe(false);

      const row = await prisma.registroCombustible.findUniqueOrThrow({
        where: { id: payload.id },
      });
      const claimed = (await listKeys(rawS3, TEST_BUCKET)).filter(
        (k) => k === row.fotoKey,
      );
      expect(claimed).toHaveLength(1);
      expect(
        await prisma.registroCombustible.count({ where: { id: payload.id } }),
      ).toBe(1);

      const other = await supervisorBAgent
        .post('/api/combustible')
        .send({ ...payload, fotoKey: undefined })
        .expect(409);
      expect((other.body as ErrorEnvelope).code).toBe('ID_CONFLICT');
    });
  });

  // ---------------------------------------------------------------------
  describe('PATCH con X-Expected', () => {
    it('equipo: precondición vencida -> 409 STALE_UPDATE; vigente -> 200; el reintento (actual == deseado) -> 200', async () => {
      const equipo = await newEquipment();

      const stale = await adminAgent
        .patch(`/api/equipment/${equipo.id}`)
        .set('X-Expected', expectedHeader({ brand: 'Komatsu' }))
        .send({ brand: 'CAT' })
        .expect(409);
      expect((stale.body as ErrorEnvelope).code).toBe('STALE_UPDATE');

      await adminAgent
        .patch(`/api/equipment/${equipo.id}`)
        .set('X-Expected', expectedHeader({ brand: 'Caterpillar' }))
        .send({ brand: 'CAT' })
        .expect(200);
      // La respuesta se perdió y la cola reintenta con la misma base.
      await adminAgent
        .patch(`/api/equipment/${equipo.id}`)
        .set('X-Expected', expectedHeader({ brand: 'Caterpillar' }))
        .send({ brand: 'CAT' })
        .expect(200);

      const row = await prisma.equipment.findUniqueOrThrow({
        where: { id: equipo.id },
      });
      expect(row.brand).toBe('CAT');
    });

    it('sin header: última escritura gana, como siempre', async () => {
      const equipo = await newEquipment();

      await adminAgent
        .patch(`/api/equipment/${equipo.id}`)
        .send({ brand: 'Volvo' })
        .expect(200);

      const row = await prisma.equipment.findUniqueOrThrow({
        where: { id: equipo.id },
      });
      expect(row.brand).toBe('Volvo');
    });

    it('header con caracteres no ASCII (tildes, «—», comillas tipográficas) viaja codificado', async () => {
      const branch = await newBranch('Header');
      await adminAgent
        .patch(`/api/branches/${branch.id}`)
        .send({ address: 'Av. Ñuñoa — “Norte” 123' })
        .expect(200);

      const stale = await adminAgent
        .patch(`/api/branches/${branch.id}`)
        .set(
          'X-Expected',
          expectedHeader({ address: 'Dirección — vieja “comillas”' }),
        )
        .send({ address: 'Otra' })
        .expect(409);
      expect((stale.body as ErrorEnvelope).code).toBe('STALE_UPDATE');

      await adminAgent
        .patch(`/api/branches/${branch.id}`)
        .set(
          'X-Expected',
          expectedHeader({ address: 'Av. Ñuñoa — “Norte” 123' }),
        )
        .send({ address: 'Otra' })
        .expect(200);
    });

    it('un header que no es encodeURIComponent(JSON) -> 400', async () => {
      const branch = await newBranch('Header malo');

      await adminAgent
        .patch(`/api/branches/${branch.id}`)
        .set('X-Expected', 'esto-no-es-json')
        .send({ address: 'X' })
        .expect(400);
    });

    describe('forma del header (nunca un 500)', () => {
      const patchBranch = async (header: string, id: string) =>
        adminAgent
          .patch(`/api/branches/${id}`)
          .set('X-Expected', header)
          .send({ address: 'X' });

      it('un header de más de 8 KB -> 400', async () => {
        const branch = await newBranch('Header gigante');

        const response = await patchBranch(
          expectedHeader({ address: 'a'.repeat(9000) }),
          branch.id,
        );

        expect(response.status).toBe(400);
      });

      it('un anidamiento profundo -> 400, no un RangeError', async () => {
        const branch = await newBranch('Header profundo');
        const profundo = '['.repeat(2500) + ']'.repeat(2500);

        const response = await patchBranch(
          encodeURIComponent(`{"address":${profundo}}`),
          branch.id,
        );

        expect(response.status).toBe(400);
      });

      it.each([
        ['un objeto', { address: { a: 1 } }],
        ['un arreglo con objetos', { address: [{ a: 1 }] }],
        ['un arreglo anidado', { address: [[1]] }],
      ])('un valor que es %s -> 400', async (label, expected) => {
        const branch = await newBranch(`Header forma ${label}`);

        const response = await patchBranch(expectedHeader(expected), branch.id);

        expect(response.status).toBe(400);
      });

      it('las claves __proto__ y constructor se ignoran: ni 500 ni contaminación', async () => {
        const branch = await newBranch('Header proto');

        const response = await patchBranch(
          encodeURIComponent('{"__proto__":1,"constructor":"x","toString":2}'),
          branch.id,
        );

        expect(response.status).toBe(200);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      });

      it('un campo heredado no cuenta como campo de la fila', async () => {
        const branch = await newBranch('Header heredado');

        const response = await patchBranch(
          expectedHeader({ hasOwnProperty: 'otra-cosa' }),
          branch.id,
        );

        expect(response.status).toBe(200);
      });
    });

    it('estado y asignación del equipo', async () => {
      const equipo = await newEquipment();
      const operator = await newOperator();

      const staleStatus = await supervisorAgent
        .patch(`/api/equipment/${equipo.id}/status`)
        .set('X-Expected', expectedHeader({ status: 'OUT_OF_SERVICE' }))
        .send({ status: 'IN_WORKSHOP' })
        .expect(409);
      expect((staleStatus.body as ErrorEnvelope).code).toBe('STALE_UPDATE');
      await supervisorAgent
        .patch(`/api/equipment/${equipo.id}/status`)
        .set('X-Expected', expectedHeader({ status: 'OPERATIONAL' }))
        .send({ status: 'IN_WORKSHOP' })
        .expect(200);

      await supervisorAgent
        .patch(`/api/equipment/${equipo.id}/assignment`)
        .set('X-Expected', expectedHeader({ operatorId: null }))
        .send({ operatorId: operator.id })
        .expect(200);
      const staleAssignment = await supervisorAgent
        .patch(`/api/equipment/${equipo.id}/assignment`)
        .set('X-Expected', expectedHeader({ operatorId: null }))
        .send({ operatorId: null })
        .expect(409);
      expect((staleAssignment.body as ErrorEnvelope).code).toBe('STALE_UPDATE');
    });

    it('documento (el archivo no entra a la precondición), ítem, categoría y operador', async () => {
      const equipo = await newEquipment();
      const docId = randomUUID();
      await supervisorAgent
        .post(`/api/equipment/${equipo.id}/documents`)
        .send({ id: docId, type: 'INSURANCE', title: 'Póliza' })
        .expect(201);
      const staleDoc = await supervisorAgent
        .patch(`/api/equipment/documents/${docId}`)
        .set('X-Expected', expectedHeader({ title: 'Otro título' }))
        .send({ title: 'Póliza 2026' })
        .expect(409);
      expect((staleDoc.body as ErrorEnvelope).code).toBe('STALE_UPDATE');
      await supervisorAgent
        .patch(`/api/equipment/documents/${docId}`)
        .set(
          'X-Expected',
          expectedHeader({ title: 'Póliza', fileKey: 'ignorado' }),
        )
        .send({ title: 'Póliza 2026' })
        .expect(200);

      const branch = await newBranch('Patch');
      const item = await newItem(branch.id, 1);
      const staleItem = await adminAgent
        .patch(`/api/inventory/items/${item.id}`)
        .set('X-Expected', expectedHeader({ name: 'Nombre viejo' }))
        .send({ name: 'Nombre nuevo' })
        .expect(409);
      expect((staleItem.body as ErrorEnvelope).code).toBe('STALE_UPDATE');
      await adminAgent
        .patch(`/api/inventory/items/${item.id}`)
        .set('X-Expected', expectedHeader({ name: `Ítem e2e ${RUN_ID}` }))
        .send({ name: 'Nombre nuevo' })
        .expect(200);

      const categoryId = randomUUID();
      categoryIds.push(categoryId);
      await adminAgent
        .post('/api/inventory/categories')
        .send({ id: categoryId, name: `Cat patch ${RUN_ID}` })
        .expect(201);
      const staleCategory = await adminAgent
        .patch(`/api/inventory/categories/${categoryId}`)
        .set('X-Expected', expectedHeader({ name: 'Otra' }))
        .send({ name: `Cat nueva ${RUN_ID}` })
        .expect(409);
      expect((staleCategory.body as ErrorEnvelope).code).toBe('STALE_UPDATE');

      const operator = await newOperator();
      const staleOperator = await adminAgent
        .patch(`/api/operators/${operator.id}`)
        .set('X-Expected', expectedHeader({ name: 'Otro nombre' }))
        .send({ name: 'Nombre nuevo' })
        .expect(409);
      expect((staleOperator.body as ErrorEnvelope).code).toBe('STALE_UPDATE');
      await adminAgent
        .patch(`/api/operators/${operator.id}`)
        .set('X-Expected', expectedHeader({ name: `Operador e2e ${RUN_ID}` }))
        .send({ name: 'Nombre nuevo' })
        .expect(200);
    });

    it('orden de trabajo y actividad', async () => {
      const equipo = await newEquipment();
      const ordenId = randomUUID();
      ordenIds.push(ordenId);
      await adminAgent
        .post('/api/mantenimiento/ordenes')
        .send({ id: ordenId, equipoId: equipo.id, titulo: `Orden ${RUN_ID}` })
        .expect(201);

      const staleOrden = await adminAgent
        .patch(`/api/mantenimiento/ordenes/${ordenId}`)
        .set('X-Expected', expectedHeader({ estado: 'EN_PROCESO' }))
        .send({ estado: 'COMPLETADA' })
        .expect(409);
      expect((staleOrden.body as ErrorEnvelope).code).toBe('STALE_UPDATE');
      await adminAgent
        .patch(`/api/mantenimiento/ordenes/${ordenId}`)
        .set('X-Expected', expectedHeader({ estado: 'PENDIENTE' }))
        .send({ estado: 'COMPLETADA' })
        .expect(200);
      // El reintento de la misma edición ya aplicada pasa.
      await adminAgent
        .patch(`/api/mantenimiento/ordenes/${ordenId}`)
        .set('X-Expected', expectedHeader({ estado: 'PENDIENTE' }))
        .send({ estado: 'COMPLETADA' })
        .expect(200);

      const actividadId = randomUUID();
      actividadIds.push(actividadId);
      await adminAgent
        .post('/api/mantenimiento/actividades')
        .send({ id: actividadId, descripcion: 'Act', origen: 'MANUAL' })
        .expect(201);
      const staleActividad = await adminAgent
        .patch(`/api/mantenimiento/actividades/${actividadId}`)
        .set('X-Expected', expectedHeader({ estado: 'EN_PROCESO' }))
        .send({ estado: 'COMPLETADA' })
        .expect(409);
      expect((staleActividad.body as ErrorEnvelope).code).toBe('STALE_UPDATE');
    });
  });

  // ---------------------------------------------------------------------
  describe('createdById nunca sale, en ningún nivel de la respuesta', () => {
    it('equipo con sucursal base: detalle, lista y replay del create', async () => {
      const branch = await newBranch('Base');
      const payload = {
        id: randomUUID(),
        ...baseEquipmentPayload(nextCode()),
        homeBranchId: branch.id,
      };
      equipmentIds.push(payload.id);

      const created = await adminAgent
        .post('/api/equipment')
        .send(payload)
        .expect(201);
      const replay = await adminAgent
        .post('/api/equipment')
        .send(payload)
        .expect(201);
      const detail = await mantenedorAgent
        .get(`/api/equipment/${payload.id}`)
        .expect(200);
      const list = await mantenedorAgent.get('/api/equipment').expect(200);

      expectNoCreatedById(created.body);
      expectNoCreatedById(replay.body);
      expectNoCreatedById(detail.body);
      expectNoCreatedById(list.body);
      // La sucursal sí viaja en la ficha, solo que sin el dueño.
      expect(
        (detail.body as ApiEnvelope<{ homeBranch: IdData }>).data.homeBranch.id,
      ).toBe(branch.id);
    });

    it('el replay del create de equipo responde la misma forma que el create', async () => {
      const branch = await newBranch('Forma');
      const payload = {
        id: randomUUID(),
        ...baseEquipmentPayload(nextCode()),
        homeBranchId: branch.id,
      };
      equipmentIds.push(payload.id);

      const created = await adminAgent
        .post('/api/equipment')
        .send(payload)
        .expect(201);
      const replay = await adminAgent
        .post('/api/equipment')
        .send(payload)
        .expect(201);

      const keys = (res: { body: unknown }) =>
        Object.keys((res.body as ApiEnvelope<IdData>).data).sort();
      expect(keys(replay)).toEqual(keys(created));
    });

    it('documentos, ítems, categorías, sucursales y operadores', async () => {
      const equipo = await newEquipment();
      const branch = await newBranch('Lectura');
      const item = await newItem(branch.id, 10);
      const operator = await newOperator();
      const documentId = randomUUID();

      const document = await supervisorAgent
        .post(`/api/equipment/${equipo.id}/documents`)
        .send({ id: documentId, type: 'INSURANCE' })
        .expect(201);
      const documents = await supervisorAgent
        .get(`/api/equipment/${equipo.id}/documents`)
        .expect(200);
      const itemDetail = await mantenedorAgent
        .get(`/api/inventory/items/${item.id}`)
        .expect(200);
      const itemList = await mantenedorAgent
        .get('/api/inventory/items')
        .expect(200);
      const categories = await mantenedorAgent
        .get('/api/inventory/categories')
        .expect(200);
      const branches = await mantenedorAgent.get('/api/branches').expect(200);
      const operators = await supervisorAgent.get('/api/operators').expect(200);
      const operatorDetail = await supervisorAgent
        .get(`/api/operators/${operator.id}`)
        .expect(200);

      for (const res of [
        document,
        documents,
        itemDetail,
        itemList,
        categories,
        branches,
        operators,
        operatorDetail,
      ]) {
        expectNoCreatedById(res.body);
      }
    });

    it('órdenes, intervenciones, actividades, umbrales y combustible', async () => {
      const equipo = await newEquipment();
      const ordenId = randomUUID();
      ordenIds.push(ordenId);

      const orden = await adminAgent
        .post('/api/mantenimiento/ordenes')
        .send({
          id: ordenId,
          equipoId: equipo.id,
          titulo: `Orden lectura ${RUN_ID}`,
          tareas: [{ texto: 'Revisar' }],
        })
        .expect(201);
      const ordenes = await adminAgent
        .get('/api/mantenimiento/ordenes')
        .expect(200);
      const ordenDetail = await adminAgent
        .get(`/api/mantenimiento/ordenes/${ordenId}`)
        .expect(200);
      const intervencion = await mantenedorAgent
        .post(`/api/mantenimiento/ordenes/${ordenId}/intervenciones`)
        .send({ id: randomUUID(), tipo: 'CORRECTIVA', detalle: 'Ajuste' })
        .expect(201);
      const intervenciones = await mantenedorAgent
        .get(`/api/mantenimiento/ordenes/${ordenId}/intervenciones`)
        .expect(200);
      const actividades = await adminAgent
        .get('/api/mantenimiento/actividades')
        .expect(200);
      const umbrales = await adminAgent
        .get('/api/mantenimiento/umbrales')
        .expect(200);
      const combustible = await supervisorAgent
        .post('/api/combustible')
        .send({
          id: randomUUID(),
          equipoId: equipo.id,
          litros: 30,
          tipo: 'PETROLEO',
        })
        .expect(201);
      const combustibles = await supervisorAgent
        .get('/api/combustible')
        .expect(200);

      for (const res of [
        orden,
        ordenes,
        ordenDetail,
        intervencion,
        intervenciones,
        actividades,
        umbrales,
        combustible,
        combustibles,
      ]) {
        expectNoCreatedById(res.body);
      }
    });
  });

  // ---------------------------------------------------------------------
  describe('DELETE de un id inexistente responde 404 (el front lo trata como «ya hecho»)', () => {
    const missing = () => randomUUID();

    it.each([
      ['equipo', (id: string) => `/api/equipment/${id}`],
      ['documento', (id: string) => `/api/equipment/documents/${id}`],
      ['sucursal', (id: string) => `/api/branches/${id}`],
      ['operador', (id: string) => `/api/operators/${id}`],
      ['ítem', (id: string) => `/api/inventory/items/${id}`],
      ['categoría', (id: string) => `/api/inventory/categories/${id}`],
    ])('%s', async (_label, path) => {
      await adminAgent.delete(path(missing())).expect(404);
    });
  });
});
