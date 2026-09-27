/**
 * Gate e2e completo de Flota en Cloudflare R2 (Fase 5 del RFC R2-storage):
 * ejercita, contra una app Nest real (mismo pipeline que `main.ts`, vía
 * `configureApp`) y contra Postgres + MinIO REALES (sin mocks), los 3 usos
 * de Flota — foto de equipo, documento de equipo, foto de carga de
 * combustible — más la ficha consolidada y el legacy `/api/uploads`.
 *
 * Bucket DEDICADO (`smi-files-e2e`, no el `smi-files` de dev/otros tests) —
 * ver `ensureBucketExists`. `STORAGE_BUCKET` se fija en `process.env` ANTES
 * de importar `AppModule`/`env` (ver el comentario junto a esa línea) para
 * que `env.storageBucket` resuelva al bucket de e2e.
 *
 * Se salta completo (`describe.skip`) si MinIO o Postgres no están arriba —
 * mismo patrón síncrono que `src/storage/storage.integration.spec.ts`.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

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

/** Chequeo TCP crudo (host/puerto hardcodeados, igual que `isMinioReachable`
 * — el `DATABASE_URL` real de `.env` apunta acá, ver `.env`). No valida
 * credenciales, solo que Postgres esté escuchando. */
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

const TEST_BUCKET = 'smi-files-e2e';
// IMPORTANTE: `env.ts` lee `process.env.STORAGE_BUCKET` en IMPORT-TIME
// (`import 'dotenv/config'` + construcción del objeto `env` al tope del
// módulo). Esta asignación debe correr ANTES del primer `import` real de
// `AppModule`/`env`/cualquier cosa que los arrastre — de abajo. Verificado
// empíricamente en este repo (ts-jest, `module: nodenext`, sin
// `"type":"module"` en package.json => emite CommonJS): los `import`
// se transpilan a `require(...)` EN EL MISMO LUGAR del archivo fuente, no se
// hoistean como en ESM puro — así que este assignment corre antes que el
// `require('../src/app.module')` de la sección de imports "pesados".
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
import {
  ControlUnit,
  EquipmentClass,
  EquipmentDocumentType,
} from '@prisma/client';

import { AppModule } from '../src/app.module';
import { configureApp, NEST_APP_CREATE_OPTIONS } from '../src/app.setup';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  DEFAULT_DEV_STORAGE_ACCESS_KEY_ID,
  DEFAULT_DEV_STORAGE_SECRET_ACCESS_KEY,
  env,
} from '../src/common/config/env';
import { UPLOAD_DIR } from '../src/uploads/uploads.controller';

const maybeDescribe =
  minioReachable && postgresReachable ? describe : describe.skip;

if (!minioReachable || !postgresReachable) {
  console.warn(
    `files-storage.e2e-spec: SALTEADO (MinIO reachable=${minioReachable}, ` +
      `Postgres reachable=${postgresReachable}) — levantar con ` +
      '"docker compose up -d minio minio-init smi-postgres"',
  );
}

const SEED_PASSWORD = 'Smi123456!';
type SupertestAgent = ReturnType<typeof request.agent>;

const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
]);
const MINIMAL_PDF = Buffer.from('%PDF-1.4\n%e2e gate test pdf', 'utf8');
const HTML_AS_IMAGE = Buffer.from(
  '<!DOCTYPE html><html><body>hola</body></html>',
  'utf8',
);
const SVG_BUFFER = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  'utf8',
);
const OVERSIZED_BUFFER = Buffer.alloc(8 * 1024 * 1024 + 1);

interface ApiEnvelope<T> {
  data: T;
  message: string;
}
interface ErrorEnvelope {
  data: null;
  message: string;
}
interface UploadFileData {
  key: string;
  url: string;
}
interface LegacyUploadData {
  url: string;
}
interface EquipmentData {
  id: string;
  internalCode: string;
  photoUrl: string | null;
  [key: string]: unknown;
}
interface EquipmentDocumentData {
  id: string;
  equipmentId: string;
  fileUrl: string | null;
  fileName: string | null;
  [key: string]: unknown;
}
interface CombustibleData {
  id: string;
  equipoId: string;
  fotoUrl: string | null;
  [key: string]: unknown;
}
interface FichaTimelineEvent {
  id: string;
  tipo: string;
  meta: { fotoUrl?: string | null; [key: string]: unknown };
  [key: string]: unknown;
}
interface FichaData {
  equipo: { id: string; [key: string]: unknown };
  timeline: FichaTimelineEvent[];
  [key: string]: unknown;
}
interface CreateEquipmentPayload {
  internalCode: string;
  equipmentClass: EquipmentClass;
  type: string;
  brand: string;
  model: string;
  controlUnit: ControlUnit;
  photoKey?: string | null;
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

function baseEquipmentPayload(internalCode: string): CreateEquipmentPayload {
  return {
    internalCode,
    equipmentClass: EquipmentClass.LIGHT,
    type: 'Camioneta',
    brand: 'Toyota',
    model: 'Hilux',
    controlUnit: ControlUnit.KM,
  };
}

function tamperSignature(rawUrl: string): string {
  const url = new URL(rawUrl);
  const signature = url.searchParams.get('X-Amz-Signature');
  if (!signature) {
    throw new Error('La URL firmada no trae X-Amz-Signature — ¿cambió el SDK?');
  }
  const tampered =
    signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');
  url.searchParams.set('X-Amz-Signature', tampered);
  return url.toString();
}

function assertNoKeyLeak(body: unknown): void {
  expect(JSON.stringify(body)).not.toMatch(/photoKey|fileKey|fotoKey|tmp\//);
}

maybeDescribe('Flota — foto/documento/combustible en R2 (e2e)', () => {
  jest.setTimeout(30_000);

  let app: NestExpressApplication;
  let prisma: PrismaService;
  let rawS3: S3Client;

  let adminAgent: SupertestAgent;
  let supervisorAgent: SupertestAgent;
  let operadorAgent: SupertestAgent;

  // `internalCode` tiene @MaxLength(20) — "E2E-" (4) + RUN_ID (5) + "-" (1) =
  // 10 chars fijos, deja 10 para el sufijo.
  const RUN_ID = randomUUID().slice(0, 5);
  const internalCode = (suffix: string) => `E2E-${RUN_ID}-${suffix}`;

  const createdEquipmentIds: string[] = [];
  let legacyUploadUrl: string | undefined;

  // Estado compartido del flujo "camino feliz" sobre un mismo equipo —
  // poblado progresivamente por los tests de la sección `Happy paths`.
  let equoPrincipal: EquipmentData;
  let equoPrincipalPhotoKeyReal: string; // leído directo de la BD (la API nunca expone la key cruda)
  let docPoliza: EquipmentDocumentData;
  let ultimaPhotoUrlConocida: string;

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
    operadorAgent = await loginAgent(app, 'operador@smi.local', SEED_PASSWORD);
  });

  afterAll(async () => {
    if (legacyUploadUrl) {
      rmSync(join(UPLOAD_DIR, legacyUploadUrl.replace('/uploads/', '')), {
        force: true,
      });
    }

    if (createdEquipmentIds.length > 0) {
      await prisma.registroCombustible.deleteMany({
        where: { equipoId: { in: createdEquipmentIds } },
      });
      await prisma.equipmentDocument.deleteMany({
        where: { equipmentId: { in: createdEquipmentIds } },
      });
      await prisma.equipment.deleteMany({
        where: { id: { in: createdEquipmentIds } },
      });
    }

    await deleteAllObjects(rawS3, TEST_BUCKET);

    await app.close();
  });

  describe('Happy paths', () => {
    it('2) admin crea un equipo con photoKey -> photoUrl firmada, fetch 200', async () => {
      const upload = await uploadViaApi(adminAgent, MINIMAL_JPEG, 'foto.jpg');

      const response = await adminAgent
        .post('/api/equipment')
        .send({
          ...baseEquipmentPayload(internalCode('PRINCIPAL')),
          photoKey: upload.key,
        })
        .expect(201);

      equoPrincipal = (response.body as ApiEnvelope<EquipmentData>).data;
      createdEquipmentIds.push(equoPrincipal.id);
      expect(equoPrincipal.photoUrl).toBeTruthy();
      ultimaPhotoUrlConocida = equoPrincipal.photoUrl as string;

      const fetched = await fetch(ultimaPhotoUrlConocida);
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('content-type')).toBe('image/jpeg');

      // Capturado directo de la BD para el negativo #14 ("otra key FINAL") —
      // la API nunca expone la key cruda, solo la URL firmada.
      const row = await prisma.equipment.findUniqueOrThrow({
        where: { id: equoPrincipal.id },
        select: { photoKey: true },
      });
      equoPrincipalPhotoKeyReal = row.photoKey as string;
      expect(equoPrincipalPhotoKeyReal).toMatch(/^equipment-photos\/.+\.jpg$/);
    });

    it('1) supervisor sube un PDF y crea un documento con fileKey+fileName -> fileUrl firmada, fetch 200 con Content-Disposition RFC5987', async () => {
      const upload = await uploadViaApi(
        supervisorAgent,
        MINIMAL_PDF,
        'poliza.pdf',
      );

      const response = await supervisorAgent
        .post(`/api/equipment/${equoPrincipal.id}/documents`)
        .send({
          type: EquipmentDocumentType.INSURANCE,
          fileKey: upload.key,
          fileName: 'Póliza Seguro.pdf',
        })
        .expect(201);

      docPoliza = (response.body as ApiEnvelope<EquipmentDocumentData>).data;
      expect(docPoliza.fileUrl).toBeTruthy();
      expect(docPoliza.fileName).toBe('Póliza Seguro.pdf');

      const fetched = await fetch(docPoliza.fileUrl as string);
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('content-type')).toBe('application/pdf');
      expect(fetched.headers.get('content-disposition')).toContain(
        "filename*=UTF-8''P%C3%B3liza",
      );
    });

    it('10) GET /api/equipment/documents/:id/file -> 302 a una URL firmada que devuelve 200', async () => {
      const redirectResponse = await supervisorAgent
        .get(`/api/equipment/documents/${docPoliza.id}/file`)
        .redirects(0)
        .expect(302);

      const location: string = redirectResponse.headers.location;
      expect(location).toBeTruthy();

      const fetched = await fetch(location);
      expect(fetched.status).toBe(200);
    });

    it('3) PATCH sin photoKey mantiene la foto (el objeto sigue existiendo)', async () => {
      const response = await adminAgent
        .patch(`/api/equipment/${equoPrincipal.id}`)
        .send({ type: 'Camioneta Doble Cabina' })
        .expect(200);

      const data = (response.body as ApiEnvelope<EquipmentData>).data;
      expect(data.photoUrl).toBeTruthy();
      expect(data.type).toBe('Camioneta Doble Cabina');

      const fetched = await fetch(data.photoUrl as string);
      expect(fetched.status).toBe(200);
    });

    it('4) reemplazar la foto: la URL vieja pasa a 404 y la nueva a 200', async () => {
      const oldPhotoUrl = ultimaPhotoUrlConocida;
      const upload = await uploadViaApi(
        adminAgent,
        MINIMAL_JPEG,
        'foto-nueva.jpg',
      );

      const response = await adminAgent
        .patch(`/api/equipment/${equoPrincipal.id}`)
        .send({ photoKey: upload.key })
        .expect(200);

      const data = (response.body as ApiEnvelope<EquipmentData>).data;
      expect(data.photoUrl).toBeTruthy();
      expect(data.photoUrl).not.toBe(oldPhotoUrl);
      ultimaPhotoUrlConocida = data.photoUrl as string;

      const [oldFetch, newFetch] = await Promise.all([
        fetch(oldPhotoUrl),
        fetch(ultimaPhotoUrlConocida),
      ]);
      expect(oldFetch.status).toBe(404);
      expect(newFetch.status).toBe(200);
    });

    it('9) dos GET seguidos devuelven la MISMA URL firmada (ventana estable memoizada)', async () => {
      const [first, second] = await Promise.all([
        adminAgent.get(`/api/equipment/${equoPrincipal.id}`).expect(200),
        adminAgent.get(`/api/equipment/${equoPrincipal.id}`).expect(200),
      ]);

      const firstUrl = (first.body as ApiEnvelope<EquipmentData>).data.photoUrl;
      const secondUrl = (second.body as ApiEnvelope<EquipmentData>).data
        .photoUrl;
      expect(firstUrl).toBe(secondUrl);
    });

    it('5) photoKey: null borra la foto (photoUrl null + objeto borrado)', async () => {
      const response = await adminAgent
        .patch(`/api/equipment/${equoPrincipal.id}`)
        .send({ photoKey: null })
        .expect(200);

      const data = (response.body as ApiEnvelope<EquipmentData>).data;
      expect(data.photoUrl).toBeNull();

      const fetched = await fetch(ultimaPhotoUrlConocida);
      expect(fetched.status).toBe(404);
    });

    it('6) DELETE del documento borra su objeto (404 después)', async () => {
      const fileUrlAntes = docPoliza.fileUrl as string;

      await supervisorAgent
        .delete(`/api/equipment/documents/${docPoliza.id}`)
        .expect(200);

      const fetched = await fetch(fileUrlAntes);
      expect(fetched.status).toBe(404);
    });

    it('7) DELETE de un equipo SIN historial borra su foto', async () => {
      const upload = await uploadViaApi(
        adminAgent,
        MINIMAL_JPEG,
        'desechable.jpg',
      );
      const createResponse = await adminAgent
        .post('/api/equipment')
        .send({
          ...baseEquipmentPayload(internalCode('BAJA')),
          photoKey: upload.key,
        })
        .expect(201);
      const equoDesechable = (createResponse.body as ApiEnvelope<EquipmentData>)
        .data;
      createdEquipmentIds.push(equoDesechable.id);
      const photoUrl = equoDesechable.photoUrl as string;

      await adminAgent
        .delete(`/api/equipment/${equoDesechable.id}`)
        .expect(200);

      const fetched = await fetch(photoUrl);
      expect(fetched.status).toBe(404);
    });

    it('8) combustible con fotoKey: firmada en /api/combustible y en la ficha (meta.fotoUrl)', async () => {
      const upload = await uploadViaApi(
        supervisorAgent,
        MINIMAL_JPEG,
        'surtidor.jpg',
      );

      const createResponse = await supervisorAgent
        .post('/api/combustible')
        .send({
          equipoId: equoPrincipal.id,
          litros: 45.5,
          tipo: 'PETROLEO',
          fotoKey: upload.key,
        })
        .expect(201);
      const combustible = (createResponse.body as ApiEnvelope<CombustibleData>)
        .data;
      expect(combustible.fotoUrl).toBeTruthy();

      const listResponse = await supervisorAgent
        .get('/api/combustible')
        .expect(200);
      const listado = (listResponse.body as ApiEnvelope<CombustibleData[]>)
        .data;
      const enListado = listado.find((r) => r.id === combustible.id);
      expect(enListado?.fotoUrl).toBeTruthy();

      const fichaResponse = await supervisorAgent
        .get(`/api/equipos/${equoPrincipal.id}/ficha`)
        .expect(200);
      const ficha = (fichaResponse.body as ApiEnvelope<FichaData>).data;
      const eventoCombustible = ficha.timeline.find(
        (e) => e.id === combustible.id && e.tipo === 'COMBUSTIBLE',
      );
      expect(eventoCombustible?.meta.fotoUrl).toBeTruthy();
    });
  });

  describe('Negativos de seguridad', () => {
    it('11) fetch del objeto sin firma -> 403', async () => {
      const upload = await uploadViaApi(
        supervisorAgent,
        MINIMAL_JPEG,
        'sin-firma.jpg',
      );
      const unsignedUrl = upload.url.split('?')[0];
      const fetched = await fetch(unsignedUrl);
      expect(fetched.status).toBe(403);
    });

    it('12) firma alterada -> 403', async () => {
      const upload = await uploadViaApi(
        supervisorAgent,
        MINIMAL_JPEG,
        'firma-alterada.jpg',
      );
      const fetched = await fetch(tamperSignature(upload.url));
      expect(fetched.status).toBe(403);
    });

    it('13) tmp key de OTRO usuario -> 400', async () => {
      const upload = await uploadViaApi(
        supervisorAgent,
        MINIMAL_JPEG,
        'de-supervisor.jpg',
      );

      const response = await adminAgent
        .post('/api/equipment')
        .send({
          ...baseEquipmentPayload(internalCode('OWNERSHIP')),
          photoKey: upload.key,
        })
        .expect(400);

      expect((response.body as ErrorEnvelope).message).toContain(
        'otro usuario',
      );
    });

    it('14) key FINAL de otro equipo (no tmp/) -> 400', async () => {
      // Rechazado en la CAPA DEL DTO (regex de forma, exige el prefijo
      // "tmp/") antes de llegar al service — nunca dispara el chequeo de
      // ownership del escenario #13, distinguible porque el mensaje NO
      // menciona "otro usuario".
      const response = await adminAgent
        .post('/api/equipment')
        .send({
          ...baseEquipmentPayload(internalCode('FINALKEY')),
          photoKey: equoPrincipalPhotoKeyReal,
        })
        .expect(400);

      const message = (response.body as ErrorEnvelope).message;
      expect(message).toContain('photoKey');
      expect(message).not.toContain('otro usuario');
    });

    it('15) traversal, vacía o sobrelarga -> 400', async () => {
      const casos = [
        `tmp/${'a'.repeat(20)}/../../../etc/passwd.jpg`,
        '',
        `tmp/${'a'.repeat(200)}/${randomUUID()}.jpg`,
      ];

      for (const photoKey of casos) {
        await adminAgent
          .post('/api/equipment')
          .send({
            ...baseEquipmentPayload(
              internalCode(`BADKEY${casos.indexOf(photoKey)}`),
            ),
            photoKey,
          })
          .expect(400);
      }
    });

    it('16) key .pdf en el campo de foto -> 400', async () => {
      // Sube y reclama con el MISMO agente (admin) — así el único motivo de
      // rechazo posible es la extensión, no un mismatch de ownership (ver
      // escenario #13, que sí ejercita ese otro camino a propósito).
      const upload = await uploadViaApi(
        adminAgent,
        MINIMAL_PDF,
        'no-es-foto.pdf',
      );

      const response = await adminAgent
        .post('/api/equipment')
        .send({
          ...baseEquipmentPayload(internalCode('PDFPHOTO')),
          photoKey: upload.key,
        })
        .expect(400);

      expect((response.body as ErrorEnvelope).message).toContain(
        'no es válido',
      );
    });

    it('17) HTML renombrado .jpg -> 415; SVG -> 415', async () => {
      const htmlResponse = await supervisorAgent
        .post('/api/files')
        .attach('file', HTML_AS_IMAGE, 'foto.jpg')
        .expect(415);
      expect((htmlResponse.body as ErrorEnvelope).message).toContain(
        'no es una imagen',
      );

      const svgResponse = await supervisorAgent
        .post('/api/files')
        .attach('file', SVG_BUFFER, 'foto.svg')
        .expect(415);
      expect((svgResponse.body as ErrorEnvelope).message).toContain(
        'no es una imagen',
      );
    });

    it('18) más de 8MB -> 413', async () => {
      await supervisorAgent
        .post('/api/files')
        .attach('file', OVERSIZED_BUFFER, 'grande.jpg')
        .expect(413);
    }, 20_000);

    it('19) sin sesión -> 401; OPERADOR -> 403', async () => {
      await request(app.getHttpServer())
        .post('/api/equipment')
        .send(baseEquipmentPayload(internalCode('NOSESSION')))
        .expect(401);

      await operadorAgent
        .post('/api/equipment')
        .send(baseEquipmentPayload(internalCode('OPERADOR')))
        .expect(403);
    });

    it('20) combustible con fotoUrl+fotoKey juntos -> 400; fotoUrl externa -> 400', async () => {
      const juntosResponse = await supervisorAgent
        .post('/api/combustible')
        .send({
          equipoId: equoPrincipal.id,
          litros: 10,
          tipo: 'PETROLEO',
          fotoUrl: '/uploads/algo.jpg',
          fotoKey: `tmp/e2efakeowner1234567890/${randomUUID()}.jpg`,
        })
        .expect(400);
      expect((juntosResponse.body as ErrorEnvelope).message).toContain(
        'fotoUrl',
      );

      await supervisorAgent
        .post('/api/combustible')
        .send({
          equipoId: equoPrincipal.id,
          litros: 10,
          tipo: 'PETROLEO',
          fotoUrl: 'https://evil/x.jpg',
        })
        .expect(400);
    });

    it('21) body con photoUrl (no photoKey) -> 400', async () => {
      await adminAgent
        .post('/api/equipment')
        .send({
          ...baseEquipmentPayload(internalCode('PHOTOURL')),
          photoUrl: 'http://evil.com/x.jpg',
        })
        .expect(400);
    });

    it('22) ningún GET filtra photoKey/fileKey/fotoKey ni "tmp/"', async () => {
      const [listado, detalle, documentos, combustibles, ficha] =
        await Promise.all([
          supervisorAgent.get('/api/equipment').expect(200),
          supervisorAgent.get(`/api/equipment/${equoPrincipal.id}`).expect(200),
          supervisorAgent
            .get(`/api/equipment/${equoPrincipal.id}/documents`)
            .expect(200),
          supervisorAgent.get('/api/combustible').expect(200),
          supervisorAgent
            .get(`/api/equipos/${equoPrincipal.id}/ficha`)
            .expect(200),
        ]);

      for (const response of [
        listado,
        detalle,
        documentos,
        combustibles,
        ficha,
      ]) {
        assertNoKeyLeak(response.body);
      }
    });
  });

  describe('Integridad', () => {
    it('23) key tmp borrada antes del submit -> 400 (no 500)', async () => {
      const upload = await uploadViaApi(
        adminAgent,
        MINIMAL_JPEG,
        'se-va-a-borrar.jpg',
      );
      await rawS3.send(
        new DeleteObjectCommand({ Bucket: TEST_BUCKET, Key: upload.key }),
      );

      const response = await adminAgent
        .post('/api/equipment')
        .send({
          ...baseEquipmentPayload(internalCode('TMPDEL')),
          photoKey: upload.key,
        })
        .expect(400);

      expect((response.body as ErrorEnvelope).message).toContain('expiró');
    });

    it('24) P2002 al duplicar internalCode con photoKey: no deja objetos huérfanos', async () => {
      const before = await countObjectsWithPrefix(
        rawS3,
        TEST_BUCKET,
        'equipment-photos/',
      );

      const upload = await uploadViaApi(
        adminAgent,
        MINIMAL_JPEG,
        'duplicado.jpg',
      );

      const response = await adminAgent
        .post('/api/equipment')
        .send({
          ...baseEquipmentPayload(equoPrincipal.internalCode),
          photoKey: upload.key,
        })
        .expect(409);
      expect((response.body as ErrorEnvelope).message).toContain(
        equoPrincipal.internalCode,
      );

      const after = await countObjectsWithPrefix(
        rawS3,
        TEST_BUCKET,
        'equipment-photos/',
      );
      expect(after).toBe(before);
    });
  });

  describe('Legacy', () => {
    it('25) POST /api/uploads (legacy) sirve el JPEG con headers de seguridad', async () => {
      const uploadResponse = await supervisorAgent
        .post('/api/uploads')
        .attach('file', MINIMAL_JPEG, 'legacy.jpg')
        .expect(201);

      legacyUploadUrl = (uploadResponse.body as ApiEnvelope<LegacyUploadData>)
        .data.url;
      expect(legacyUploadUrl).toMatch(/^\/uploads\/.+\.jpg$/);

      const staticResponse = await request(app.getHttpServer())
        .get(legacyUploadUrl)
        .expect(200);

      expect(staticResponse.headers['x-content-type-options']).toBe('nosniff');
      expect(staticResponse.headers['content-security-policy']).toBe(
        "default-src 'none'; sandbox",
      );
      expect(staticResponse.headers['content-disposition']).toBeUndefined();
    });

    it('26) combustible con fotoUrl legacy "/uploads/..." se devuelve sin cambios', async () => {
      expect(legacyUploadUrl).toBeDefined();

      const response = await supervisorAgent
        .post('/api/combustible')
        .send({
          equipoId: equoPrincipal.id,
          litros: 12,
          tipo: 'BENCINA',
          fotoUrl: legacyUploadUrl,
        })
        .expect(201);

      const data = (response.body as ApiEnvelope<CombustibleData>).data;
      expect(data.fotoUrl).toBe(legacyUploadUrl);
    });
  });

  // Nota (expiración de URL firmada): NO implementado en este archivo. Para
  // probar la expiración habría que arrancar la app con
  // `STORAGE_SIGNED_URL_TTL_SECONDS=60` ANTES de importar `env`/`AppModule`
  // — pero `env` ya se fija una única vez por registro de módulos de ESTE
  // archivo (igual que `STORAGE_BUCKET` arriba) y este archivo ya necesita
  // el TTL default para el resto de los tests (ventana de memoización de
  // `sign()`, escenario #9). Mezclar dos TTL distintos exigiría un
  // `describe` en un ARCHIVO e2e separado (proceso/registro de módulos
  // propio) — se deja pendiente, documentado, tal como permite el plan.
});
