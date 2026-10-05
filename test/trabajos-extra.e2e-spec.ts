/**
 * Gate e2e de Trabajos extra (RFC "Supervisión en Terreno": operador del
 * catálogo en Trabajos extra + snapshot único) — ejercita el
 * contrato de `POST /api/trabajos-extra` contra una app Nest real (mismo
 * pipeline que `main.ts`, vía `configureApp`) y Postgres REAL (sin mocks):
 * operador del catálogo obligatorio, snapshot armado por el servidor, y la
 * guarda de borrado de `OperatorsService.remove` cuando el operador tiene
 * trabajos extra asociados.
 *
 * Solo necesita Postgres (a diferencia de `shift-register.e2e-spec.ts`):
 * Trabajos extra no sube fotos, así que no hay dependencia de MinIO — mismo
 * chequeo TCP crudo que usa ese archivo para Postgres, pero sin el chequeo
 * de MinIO.
 *
 * Equipos/operadores: SIEMPRE creados frescos por el test (nunca sembrados)
 * — así un rerun no choca con estado de una corrida anterior. Mismo patrón
 * que `shift-register.e2e-spec.ts` (`RUN_ID`, agentes logueados vía
 * `POST /api/auth/sign-in/email`).
 *
 * Se salta completo (`describe.skip`) si Postgres no está arriba — mismo
 * patrón síncrono que el resto de los e2e del proyecto.
 */
import { randomUUID } from 'node:crypto';

import { isPostgresReachable } from './helpers/reachability';

const postgresReachable = isPostgresReachable();

const maybeDescribe = postgresReachable ? describe : describe.skip;

if (!postgresReachable) {
  console.warn(
    'trabajos-extra.e2e-spec: SALTEADO (Postgres reachable=false) — levantar con ' +
      '"docker compose up -d smi-postgres"',
  );
}

import type { NestExpressApplication } from '@nestjs/platform-express';

import { PrismaService } from '../src/common/prisma/prisma.service';
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

interface TrabajoExtraData {
  id: string;
  equipoId: string;
  operatorId: string | null;
  operador: string;
  faena: string;
  turno: string;
  totalHoras: number;
  [key: string]: unknown;
}

maybeDescribe('Trabajos extra — operador del catálogo (e2e)', () => {
  jest.setTimeout(30_000);

  let app: NestExpressApplication;
  let prisma: PrismaService;

  let adminAgent: SupertestAgent;
  let supervisorAgent: SupertestAgent;
  let mantenedorAgent: SupertestAgent;

  // `internalCode` tiene @MaxLength(20) — "TX-" (3) + RUN_ID (5) + "-" (1) =
  // 9 chars fijos, deja 11 para el sufijo.
  const RUN_ID = randomUUID().slice(0, 5);
  const internalCode = (suffix: string) => `TX-${RUN_ID}-${suffix}`;

  const createdEquipmentIds: string[] = [];
  const createdOperatorIds: string[] = [];

  function baseTrabajoExtraPayload(
    equipoId: string,
    operatorId: string,
  ): Record<string, unknown> {
    return {
      equipoId,
      operatorId,
      faena: 'Rajo Norte',
      turno: 'DIURNO',
      horometroInicial: 1200,
      horometroFinal: 1212,
      actividades: ['REGULACION_CARGA'],
      descripcion: 'Carga de material (e2e)',
    };
  }

  async function createFreshEquipo(suffix: string): Promise<EquipmentData> {
    const response = await adminAgent
      .post('/api/equipment')
      .send(baseEquipmentPayload(internalCode(suffix)))
      .expect(201);
    const equipo = (response.body as ApiEnvelope<EquipmentData>).data;
    createdEquipmentIds.push(equipo.id);
    return equipo;
  }

  async function createOperator(
    name: string,
    isActive = true,
  ): Promise<OperatorData> {
    const response = await adminAgent
      .post('/api/operators')
      .send({ name, isActive })
      .expect(201);
    const operator = (response.body as ApiEnvelope<OperatorData>).data;
    createdOperatorIds.push(operator.id);
    return operator;
  }

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    if (createdEquipmentIds.length > 0) {
      await prisma.trabajoExtraordinario.deleteMany({
        where: { equipoId: { in: createdEquipmentIds } },
      });
      await prisma.equipment.deleteMany({
        where: { id: { in: createdEquipmentIds } },
      });
    }
    for (const operatorId of createdOperatorIds) {
      // Puede seguir 409 OPERATOR_IN_USE si un test de la sección de borrado
      // no alcanzó a limpiar el trabajo extra que lo referencia — best
      // effort, no debe tumbar el afterAll de todo el archivo.
      await adminAgent.delete(`/api/operators/${operatorId}`).catch(() => {
        /* best effort */
      });
    }

    await app.close();
  });

  describe('POST /api/trabajos-extra — operador del catálogo', () => {
    let equipo: EquipmentData;
    let operadorActivo: OperatorData;
    let operadorInactivo: OperatorData;

    it('crea el equipo y los operadores frescos para este flujo', async () => {
      equipo = await createFreshEquipo('CREATE');
      operadorActivo = await createOperator(`Operador Activo E2E ${RUN_ID}`);
      operadorInactivo = await createOperator(
        `Operador Inactivo E2E ${RUN_ID}`,
        false,
      );
    });

    it('crea con un operador del catálogo -> 201 y operador = nombre del catálogo', async () => {
      const response = await supervisorAgent
        .post('/api/trabajos-extra')
        .send(baseTrabajoExtraPayload(equipo.id, operadorActivo.id))
        .expect(201);

      const data = (response.body as ApiEnvelope<TrabajoExtraData>).data;
      expect(data.operatorId).toBe(operadorActivo.id);
      expect(data.operador).toBe(operadorActivo.name);
    });

    it('un operador INACTIVO -> 409 OPERATOR_INACTIVE', async () => {
      const response = await supervisorAgent
        .post('/api/trabajos-extra')
        .send(baseTrabajoExtraPayload(equipo.id, operadorInactivo.id))
        .expect(409);

      expect((response.body as ErrorEnvelope).code).toBe('OPERATOR_INACTIVE');
    });

    it('un operatorId inexistente -> 404', async () => {
      await supervisorAgent
        .post('/api/trabajos-extra')
        .send(baseTrabajoExtraPayload(equipo.id, randomUUID()))
        .expect(404);
    });

    it('un body con operador -> 400 (forbidNonWhitelisted)', async () => {
      await supervisorAgent
        .post('/api/trabajos-extra')
        .send({
          ...baseTrabajoExtraPayload(equipo.id, operadorActivo.id),
          operador: 'Juan Rojas',
        })
        .expect(400);
    });

    it('sin operatorId -> 400', async () => {
      const payload = baseTrabajoExtraPayload(equipo.id, operadorActivo.id);
      delete payload.operatorId;
      await supervisorAgent
        .post('/api/trabajos-extra')
        .send(payload)
        .expect(400);
    });

    it('MANTENEDOR -> 403', async () => {
      await mantenedorAgent
        .post('/api/trabajos-extra')
        .send(baseTrabajoExtraPayload(equipo.id, operadorActivo.id))
        .expect(403);
    });
  });

  describe('POST /api/trabajos-extra — idempotencia (reenvío offline)', () => {
    it('el reintento con el mismo id devuelve la misma fila sin duplicarla', async () => {
      const equipo = await createFreshEquipo('IDEM1');
      const operador = await createOperator(`Operador Idem E2E ${RUN_ID}`);
      const payload = {
        ...baseTrabajoExtraPayload(equipo.id, operador.id),
        id: randomUUID(),
      };

      const first = await supervisorAgent
        .post('/api/trabajos-extra')
        .send(payload)
        .expect(201);
      const replay = await supervisorAgent
        .post('/api/trabajos-extra')
        .send(payload)
        .expect(201);

      const firstData = (first.body as ApiEnvelope<TrabajoExtraData>).data;
      const replayData = (replay.body as ApiEnvelope<TrabajoExtraData>).data;
      expect(firstData.id).toBe(payload.id);
      expect(replayData).toEqual(firstData);
      expect(
        await prisma.trabajoExtraordinario.count({
          where: { equipoId: equipo.id },
        }),
      ).toBe(1);
    });

    it('el reintento sigue devolviendo la fila aunque el operador se haya desactivado después', async () => {
      const equipo = await createFreshEquipo('IDEM2');
      const operador = await createOperator(`Operador Baja E2E ${RUN_ID}`);
      const payload = {
        ...baseTrabajoExtraPayload(equipo.id, operador.id),
        id: randomUUID(),
      };

      const first = await supervisorAgent
        .post('/api/trabajos-extra')
        .send(payload)
        .expect(201);

      await adminAgent
        .patch(`/api/operators/${operador.id}`)
        .send({ isActive: false })
        .expect(200);

      // Un alta NUEVA con ese operador ya falla...
      await supervisorAgent
        .post('/api/trabajos-extra')
        .send({
          ...baseTrabajoExtraPayload(equipo.id, operador.id),
          id: randomUUID(),
        })
        .expect(409);

      // ...pero el reintento del alta original es idempotente.
      const replay = await supervisorAgent
        .post('/api/trabajos-extra')
        .send(payload)
        .expect(201);
      expect((replay.body as ApiEnvelope<TrabajoExtraData>).data).toEqual(
        (first.body as ApiEnvelope<TrabajoExtraData>).data,
      );
    });

    it('otro usuario con el mismo id -> 409 ID_CONFLICT', async () => {
      const equipo = await createFreshEquipo('IDEM3');
      const operador = await createOperator(`Operador Otro E2E ${RUN_ID}`);
      const payload = {
        ...baseTrabajoExtraPayload(equipo.id, operador.id),
        id: randomUUID(),
      };
      await supervisorAgent
        .post('/api/trabajos-extra')
        .send(payload)
        .expect(201);

      // El admin también puede crear, pero no es el dueño de esa fila.
      const response = await adminAgent
        .post('/api/trabajos-extra')
        .send(payload)
        .expect(409);
      expect((response.body as ErrorEnvelope).code).toBe('ID_CONFLICT');
    });

    it('capturedAt queda como fecha; uno absurdo -> 400 INVALID_CAPTURE_TIME', async () => {
      const equipo = await createFreshEquipo('IDEM4');
      const operador = await createOperator(`Operador Fecha E2E ${RUN_ID}`);
      const capturedAt = new Date(Date.now() - 2 * 3_600_000);

      const ok = await supervisorAgent
        .post('/api/trabajos-extra')
        .send({
          ...baseTrabajoExtraPayload(equipo.id, operador.id),
          id: randomUUID(),
          capturedAt: capturedAt.toISOString(),
        })
        .expect(201);
      const data = (ok.body as ApiEnvelope<TrabajoExtraData>).data;
      expect(new Date(data.fecha as string).getTime()).toBe(
        capturedAt.getTime(),
      );

      const bad = await supervisorAgent
        .post('/api/trabajos-extra')
        .send({
          ...baseTrabajoExtraPayload(equipo.id, operador.id),
          id: randomUUID(),
          capturedAt: '2001-01-01T00:00:00.000Z',
        })
        .expect(400);
      expect((bad.body as ErrorEnvelope).code).toBe('INVALID_CAPTURE_TIME');
    });
  });

  describe('POST /api/trabajos-extra — equipo con turno abierto', () => {
    it('201: un equipo con turno en curso admite el trabajo extra', async () => {
      const equipo = await createFreshEquipo('ONSHIFT');
      const operador = await createOperator(`Operador Turno E2E ${RUN_ID}`);
      const turno = await prisma.registroHorometro.create({
        data: {
          equipoId: equipo.id,
          operador: 'Turno abierto (e2e)',
          turno: 'DIURNO',
          valorInicial: 1200,
        },
      });

      try {
        const response = await supervisorAgent
          .post('/api/trabajos-extra')
          .send(baseTrabajoExtraPayload(equipo.id, operador.id))
          .expect(201);
        const data = (response.body as ApiEnvelope<TrabajoExtraData>).data;
        expect(data.equipoId).toBe(equipo.id);
        expect(data.operador).toBe(operador.name);
      } finally {
        await prisma.registroHorometro.delete({ where: { id: turno.id } });
      }
    });
  });

  describe('PATCH /api/trabajos-extra/:id — edición con operador del catálogo', () => {
    let trabajoId: string;
    let equipo: EquipmentData;
    let operadorA: OperatorData;
    let operadorB: OperatorData;

    it('crea el trabajo y dos operadores frescos', async () => {
      equipo = await createFreshEquipo('EDIT');
      operadorA = await createOperator(`Operador A Edit E2E ${RUN_ID}`);
      operadorB = await createOperator(`Operador B Edit E2E ${RUN_ID}`);
      const response = await supervisorAgent
        .post('/api/trabajos-extra')
        .send(baseTrabajoExtraPayload(equipo.id, operadorA.id))
        .expect(201);
      trabajoId = (response.body as ApiEnvelope<TrabajoExtraData>).data.id;
    });

    it('400: `operador` de texto libre ya no se acepta al editar', async () => {
      await supervisorAgent
        .patch(`/api/trabajos-extra/${trabajoId}`)
        .send({ operador: 'Texto libre' })
        .expect(400);
    });

    it('cambia de operador por catálogo: el nombre lo deriva el servidor, con equipo y sin createdById', async () => {
      const response = await supervisorAgent
        .patch(`/api/trabajos-extra/${trabajoId}`)
        .send({ operatorId: operadorB.id })
        .expect(200);
      const data = (response.body as ApiEnvelope<TrabajoExtraData>).data;

      expect(data.operatorId).toBe(operadorB.id);
      expect(data.operador).toBe(operadorB.name);
      expect(data).toHaveProperty('equipo.internalCode', equipo.internalCode);
      expect(data).not.toHaveProperty('createdById');
    });

    it('el registro de cambios muestra el operador por nombre', async () => {
      const response = await adminAgent
        .get(`/api/trabajos-extra/${trabajoId}/changes`)
        .expect(200);
      const entries = (
        response.body as ApiEnvelope<
          { changes: { label: string; before: string; after: string }[] }[]
        >
      ).data;

      expect(entries[0].changes).toEqual([
        {
          field: 'operador',
          label: 'Operador',
          before: operadorA.name,
          after: operadorB.name,
        },
      ]);
    });

    it('409 OPERATOR_INACTIVE: no se puede asignar un operador dado de baja', async () => {
      const inactivo = await createOperator(
        `Operador Baja Edit E2E ${RUN_ID}`,
        false,
      );
      const response = await supervisorAgent
        .patch(`/api/trabajos-extra/${trabajoId}`)
        .send({ operatorId: inactivo.id })
        .expect(409);
      expect((response.body as ErrorEnvelope).code).toBe('OPERATOR_INACTIVE');
    });

    it('limpia el registro de cambios del trabajo', async () => {
      await prisma.changeLog.deleteMany({
        where: { entity: 'trabajo_extra', entityId: trabajoId },
      });
    });
  });

  describe('borrar un operador con trabajos extra asociados', () => {
    it('crea equipo + operador, un trabajo extra, y bloquea el borrado -> 409 OPERATOR_IN_USE', async () => {
      const equipo = await createFreshEquipo('DELETE');
      const operador = await createOperator(
        `Operador Con Historial E2E ${RUN_ID}`,
      );

      await supervisorAgent
        .post('/api/trabajos-extra')
        .send(baseTrabajoExtraPayload(equipo.id, operador.id))
        .expect(201);

      const response = await adminAgent
        .delete(`/api/operators/${operador.id}`)
        .expect(409);
      expect((response.body as ErrorEnvelope).code).toBe('OPERATOR_IN_USE');

      // Desactivarlo SÍ debe seguir permitido — es el camino recomendado en
      // vez del borrado físico.
      await adminAgent
        .patch(`/api/operators/${operador.id}`)
        .send({ isActive: false })
        .expect(200);
    });
  });
});
