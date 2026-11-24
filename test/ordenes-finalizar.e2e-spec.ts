/**
 * Prueba e2e de «Finalizar tarea» atómico
 * (`POST /api/mantenimiento/ordenes/:id/finalizar`) contra Postgres REAL: la
 * intervención, el descuento de stock, el ancla de la pizarra y el cierre de
 * la orden quedan todos o ninguno. Los specs unitarios lo prueban con mocks;
 * acá se comprueba que el rollback de la transacción es de verdad.
 *
 * Crea y borra sus propios datos (equipo, orden, bodega, ítem): todo lleva el
 * id del run en el código/nombre, así un rerun no choca con una corrida
 * anterior y no se toca nada ajeno.
 *
 * Se salta completo (`describe.skip`) si Postgres no está arriba. Los casos
 * con fotos usan además MinIO REAL (bucket propio) y se saltan si no está.
 */
import { randomUUID } from 'node:crypto';

import { isMinioReachable, isPostgresReachable } from './helpers/reachability';

const TEST_BUCKET = 'smi-ordenes-finalizar-e2e';
// IMPORTANTE: `env.ts` lee `process.env.STORAGE_BUCKET` en IMPORT-TIME — esta
// asignación debe correr ANTES del primer `import` real de `AppModule`/`env`
// (ver la cabecera de `files-storage.e2e-spec.ts`).
process.env.STORAGE_BUCKET = TEST_BUCKET;

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ControlUnit, EquipmentClass, EstadoOT } from '@prisma/client';

import {
  DEFAULT_DEV_STORAGE_ACCESS_KEY_ID,
  DEFAULT_DEV_STORAGE_SECRET_ACCESS_KEY,
} from '../src/common/config/env';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { LIGHT_SERVICE_RECORD_KIND } from '../src/mantenimiento/maintenance-plans/maintenance-anchors';
import {
  LIGHT_SERVICE_INTERVAL_KM,
  LIGHT_SERVICE_ORIGEN_PREFIX,
} from '../src/mantenimiento/vencimientos/vencimientos-rules';
import { ApiEnvelope, ErrorEnvelope } from './helpers/api-envelope';
import { bootstrapApp } from './helpers/bootstrap-app';
import {
  loginAgent,
  SEED_PASSWORD,
  SupertestAgent,
} from './helpers/login-agent';

const postgresReachable = isPostgresReachable();
const maybeDescribe = postgresReachable ? describe : describe.skip;
const minioReachable = postgresReachable && isMinioReachable();
const maybeDescribeFotos = minioReachable ? describe : describe.skip;

if (!postgresReachable) {
  console.warn(
    'ordenes-finalizar.e2e-spec: SALTEADO (Postgres no reachable) — levantar con ' +
      '"docker compose up -d smi-postgres"',
  );
}

interface FinalizarData {
  orden: { id: string; estado: string };
  intervencion: {
    id: string;
    ordenId: string;
    insumos: { insumoId: string; cantidad: number }[];
    fotoUrl: string | null;
    fotoUrls: string[];
  };
}

const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
]);

/** Las keys del bucket de prueba que ya no son `tmp/` (fotos reclamadas). */
async function finalKeys(client: S3Client): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: TEST_BUCKET,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of listed.Contents ?? []) {
      if (object.Key && !object.Key.startsWith('tmp/')) keys.push(object.Key);
    }
    continuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return keys;
}

/** Lectura actual de la camioneta y la del servicio anterior (ancla). */
const KM_ACTUAL = 41_000;
const KM_SERVICIO_ANTERIOR = 30_000;

maybeDescribe('Finalizar orden atómico (e2e)', () => {
  jest.setTimeout(60_000);

  let app: NestExpressApplication;
  let prisma: PrismaService;
  let mantenedor: SupertestAgent;

  const RUN_ID = randomUUID().slice(0, 5).toUpperCase();
  let seq = 0;
  const equipmentIds: string[] = [];
  const ordenIds: string[] = [];
  const branchIds: string[] = [];
  const itemIds: string[] = [];

  /** Camioneta en km, sin pauta, con un servicio anterior a 30.000 km. */
  async function newCamioneta(): Promise<{ id: string; code: string }> {
    const code = `FZ-${RUN_ID}-${++seq}`;
    const equipo = await prisma.equipment.create({
      data: {
        internalCode: code,
        equipmentClass: EquipmentClass.LIGHT,
        type: 'Camioneta',
        brand: 'Toyota',
        model: 'Hilux',
        controlUnit: ControlUnit.KM,
        currentMileage: KM_ACTUAL,
      },
      select: { id: true },
    });
    equipmentIds.push(equipo.id);
    await prisma.maintenanceRecord.create({
      data: {
        equipmentId: equipo.id,
        planItemId: null,
        kind: LIGHT_SERVICE_RECORD_KIND,
        milestone: LIGHT_SERVICE_INTERVAL_KM,
        cycle: 1,
        description: `Servicio anterior e2e ${RUN_ID}`,
        counterAt: KM_SERVICIO_ANTERIOR,
        doneById: 'e2e',
        doneByName: 'e2e',
      },
    });
    return { id: equipo.id, code };
  }

  /** La OT de servicio que crea `checkLightServices`, ya EN_PROCESO. */
  async function newOrdenServicio(equipoCode: string): Promise<string> {
    const orden = await prisma.ordenTrabajo.create({
      data: {
        equipoId: equipoCode,
        titulo: `Mantención 40.000 km · ${equipoCode}`,
        estado: EstadoOT.EN_PROCESO,
        tipo: 'PREVENTIVA',
        origen: 'PREVENTIVO',
        origenDetalle: `${LIGHT_SERVICE_ORIGEN_PREFIX}mantención de 40.000 km`,
      },
      select: { id: true },
    });
    ordenIds.push(orden.id);
    return orden.id;
  }

  /** Bodega con un ítem y su saldo. */
  async function newStock(
    quantity: number,
  ): Promise<{ branchId: string; itemId: string }> {
    const branch = await prisma.branch.create({
      data: { name: `Bodega e2e finalizar ${RUN_ID}-${++seq}` },
      select: { id: true },
    });
    branchIds.push(branch.id);
    const item = await prisma.inventoryItem.create({
      data: {
        sku: `FZ${RUN_ID}${++seq}`,
        name: `Aceite e2e ${RUN_ID}`,
        stocks: { create: { branchId: branch.id, quantity } },
      },
      select: { id: true },
    });
    itemIds.push(item.id);
    return { branchId: branch.id, itemId: item.id };
  }

  const servicios = (equipmentId: string) =>
    prisma.maintenanceRecord.findMany({
      where: {
        equipmentId,
        planItemId: null,
        kind: LIGHT_SERVICE_RECORD_KIND,
      },
      orderBy: { cycle: 'asc' },
    });

  const estadoDe = async (ordenId: string) =>
    (await prisma.ordenTrabajo.findUniqueOrThrow({ where: { id: ordenId } }))
      .estado;

  const saldo = async (itemId: string, branchId: string) =>
    (
      await prisma.stock.findUniqueOrThrow({
        where: { itemId_branchId: { itemId, branchId } },
      })
    ).quantity;

  const cierre = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    tipo: 'PREVENTIVA',
    detalle: `Servicio de 40.000 km e2e ${RUN_ID}`,
    horasHombre: 2,
    ...overrides,
  });

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapApp());
    mantenedor = await loginAgent(app, 'mantenedor@smi.local', SEED_PASSWORD);
  });

  afterAll(async () => {
    // Los avisos de la orden completada salen fire-and-forget tras el commit.
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (prisma) {
      await prisma.notification.deleteMany({
        where: {
          OR: [
            ...ordenIds.map((id) => ({
              data: { path: ['ordenId'], equals: id },
            })),
            ...itemIds.map((id) => ({
              data: { path: ['itemId'], equals: id },
            })),
          ],
        },
      });
      await prisma.maintenanceRecord.deleteMany({
        where: { equipmentId: { in: equipmentIds } },
      });
      await prisma.intervencion.deleteMany({
        where: { ordenId: { in: ordenIds } },
      });
      await prisma.ordenTrabajo.deleteMany({ where: { id: { in: ordenIds } } });
      await prisma.stockMovement.deleteMany({
        where: {
          OR: [{ itemId: { in: itemIds } }, { branchId: { in: branchIds } }],
        },
      });
      await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
      await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
      await prisma.equipment.deleteMany({
        where: { id: { in: equipmentIds } },
      });
    }
    await app?.close();
  });

  it('liviano con lectura válida: orden COMPLETADA, intervención y nuevo servicio en la pizarra', async () => {
    const equipo = await newCamioneta();
    const ordenId = await newOrdenServicio(equipo.code);
    const body = cierre({ lecturaMantencion: 40_500 });

    const response = await mantenedor
      .post(`/api/mantenimiento/ordenes/${ordenId}/finalizar`)
      .send(body)
      .expect(201);

    const { data, message } = response.body as ApiEnvelope<FinalizarData>;
    expect(message).toBe('Operación finalizada');
    expect(data.orden.estado).toBe('COMPLETADA');
    expect(data.intervencion.id).toBe(body.id);

    expect(await estadoDe(ordenId)).toBe(EstadoOT.COMPLETADA);
    expect(await prisma.intervencion.count({ where: { id: body.id } })).toBe(1);
    const registros = await servicios(equipo.id);
    expect(registros).toHaveLength(2);
    expect(registros[1]).toMatchObject({
      cycle: 2,
      counterAt: 40_500,
      ordenId,
    });
  });

  it('lectura bajo el servicio anterior: 400 y no queda nada escrito', async () => {
    const equipo = await newCamioneta();
    const ordenId = await newOrdenServicio(equipo.code);
    const body = cierre({ lecturaMantencion: KM_SERVICIO_ANTERIOR - 1_000 });

    const response = await mantenedor
      .post(`/api/mantenimiento/ordenes/${ordenId}/finalizar`)
      .send(body)
      .expect(400);

    expect((response.body as ErrorEnvelope).message).toEqual(
      expect.stringContaining('no puede ser menor'),
    );
    expect(await prisma.intervencion.count({ where: { ordenId } })).toBe(0);
    expect(await estadoDe(ordenId)).toBe(EstadoOT.EN_PROCESO);
    expect(await servicios(equipo.id)).toHaveLength(1);
  });

  it('stock insuficiente: 409 y la transacción revierte todo (sin intervención, stock, orden ni ancla)', async () => {
    const equipo = await newCamioneta();
    const ordenId = await newOrdenServicio(equipo.code);
    const { branchId, itemId } = await newStock(1);
    const body = cierre({
      lecturaMantencion: 40_500,
      branchId,
      insumos: [{ insumoId: itemId, cantidad: 5 }],
    });

    await mantenedor
      .post(`/api/mantenimiento/ordenes/${ordenId}/finalizar`)
      .send(body)
      .expect(409);

    expect(await prisma.intervencion.count({ where: { ordenId } })).toBe(0);
    expect(await prisma.stockMovement.count({ where: { itemId } })).toBe(0);
    expect(await saldo(itemId, branchId)).toBe(1);
    expect(await estadoDe(ordenId)).toBe(EstadoOT.EN_PROCESO);
    expect(await servicios(equipo.id)).toHaveLength(1);
  });

  it('reintento con el mismo id tras el éxito: mismo resultado y stock descontado una sola vez', async () => {
    const equipo = await newCamioneta();
    const ordenId = await newOrdenServicio(equipo.code);
    const { branchId, itemId } = await newStock(10);
    const body = cierre({
      lecturaMantencion: 40_500,
      branchId,
      insumos: [{ insumoId: itemId, cantidad: 3 }],
    });

    const first = await mantenedor
      .post(`/api/mantenimiento/ordenes/${ordenId}/finalizar`)
      .send(body)
      .expect(201);
    const replay = await mantenedor
      .post(`/api/mantenimiento/ordenes/${ordenId}/finalizar`)
      .send(body)
      .expect(201);

    const firstData = (first.body as ApiEnvelope<FinalizarData>).data;
    const replayData = (replay.body as ApiEnvelope<FinalizarData>).data;
    expect(replayData.orden.id).toBe(firstData.orden.id);
    expect(replayData.orden.estado).toBe('COMPLETADA');
    expect(replayData.intervencion.id).toBe(firstData.intervencion.id);
    expect(replayData.intervencion.insumos).toEqual(
      firstData.intervencion.insumos,
    );

    expect(await saldo(itemId, branchId)).toBe(7);
    expect(await prisma.stockMovement.count({ where: { itemId } })).toBe(1);
    expect(await prisma.intervencion.count({ where: { ordenId } })).toBe(1);
    expect(await servicios(equipo.id)).toHaveLength(2);
  });

  maybeDescribeFotos('varias fotos del cierre (MinIO)', () => {
    let rawS3: S3Client;

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
      try {
        await rawS3.send(new HeadBucketCommand({ Bucket: TEST_BUCKET }));
      } catch {
        await rawS3.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));
      }
    });

    afterAll(async () => {
      const listed = await rawS3.send(
        new ListObjectsV2Command({ Bucket: TEST_BUCKET }),
      );
      for (const object of listed.Contents ?? []) {
        await rawS3.send(
          new DeleteObjectCommand({ Bucket: TEST_BUCKET, Key: object.Key }),
        );
      }
    });

    const subirFoto = async (nombre: string): Promise<string> => {
      const upload = await mantenedor
        .post('/api/files')
        .attach('file', MINIMAL_JPEG, nombre)
        .expect(201);
      return (upload.body as ApiEnvelope<{ key: string }>).data.key;
    };

    it('2 fotos: dos filas en orden, dos URLs firmadas y el reintento no duplica', async () => {
      const equipo = await newCamioneta();
      const ordenId = await newOrdenServicio(equipo.code);
      const fotoKeys = [
        await subirFoto('antes.jpg'),
        await subirFoto('despues.jpg'),
      ];
      const antes = await finalKeys(rawS3);
      const body = cierre({ lecturaMantencion: 40_500, fotoKeys });

      const first = await mantenedor
        .post(`/api/mantenimiento/ordenes/${ordenId}/finalizar`)
        .send(body)
        .expect(201);
      const replay = await mantenedor
        .post(`/api/mantenimiento/ordenes/${ordenId}/finalizar`)
        .send(body)
        .expect(201);

      const data = (first.body as ApiEnvelope<FinalizarData>).data;
      expect(data.intervencion.fotoUrls).toHaveLength(2);
      expect(data.intervencion.fotoUrl).toBe(data.intervencion.fotoUrls[0]);
      expect(JSON.stringify(first.body)).not.toMatch(/fotoKey|tmp\//);
      const replayData = (replay.body as ApiEnvelope<FinalizarData>).data;
      expect(replayData.intervencion.fotoUrls).toHaveLength(2);

      const filas = await prisma.intervencionFoto.findMany({
        where: { intervencionId: body.id },
        orderBy: { orden: 'asc' },
      });
      expect(filas.map((f) => f.orden)).toEqual([0, 1]);
      // Cada foto se reclamó UNA vez (el reintento no reclama de nuevo).
      const nuevas = (await finalKeys(rawS3)).filter((k) => !antes.includes(k));
      expect(nuevas.sort()).toEqual(filas.map((f) => f.key).sort());
    });

    it('stock insuficiente con 2 fotos: 409, ninguna fila y ninguna foto reclamada queda en el bucket', async () => {
      const equipo = await newCamioneta();
      const ordenId = await newOrdenServicio(equipo.code);
      const { branchId, itemId } = await newStock(1);
      const fotoKeys = [await subirFoto('a.jpg'), await subirFoto('b.jpg')];
      const antes = await finalKeys(rawS3);
      const body = cierre({
        lecturaMantencion: 40_500,
        branchId,
        insumos: [{ insumoId: itemId, cantidad: 5 }],
        fotoKeys,
      });

      await mantenedor
        .post(`/api/mantenimiento/ordenes/${ordenId}/finalizar`)
        .send(body)
        .expect(409);

      expect(await prisma.intervencion.count({ where: { ordenId } })).toBe(0);
      expect(
        await prisma.intervencionFoto.count({
          where: { intervencionId: body.id },
        }),
      ).toBe(0);
      expect((await finalKeys(rawS3)).sort()).toEqual(antes.sort());
    });

    it('11 fotos: 400 sin escribir nada', async () => {
      const equipo = await newCamioneta();
      const ordenId = await newOrdenServicio(equipo.code);
      const body = cierre({
        lecturaMantencion: 40_500,
        fotoKeys: Array.from({ length: 11 }, (_, i) => `tmp/x/${i}.jpg`),
      });

      await mantenedor
        .post(`/api/mantenimiento/ordenes/${ordenId}/finalizar`)
        .send(body)
        .expect(400);
      expect(await estadoDe(ordenId)).toBe(EstadoOT.EN_PROCESO);
    });
  });
});
