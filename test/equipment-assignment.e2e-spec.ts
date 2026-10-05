/**
 * Prueba e2e de `PATCH /api/equipment/:id/assignment` — operadores del catálogo
 * (`Operator`, FK real desde `Equipment.currentOperatorId`): ejercita el
 * contrato contra una app Nest real (mismo pipeline que `main.ts`, vía
 * `configureApp`) y Postgres REAL (sin mocks) — asignar un operador activo,
 * rechazar uno inactivo o un id de `user`, liberar la asignación, y la guarda
 * de borrado de `OperatorsService.remove` cuando el operador está asignado a
 * un equipo.
 *
 * Solo necesita Postgres (no sube archivos) — mismo patrón que
 * `trabajos-extra.e2e-spec.ts`.
 *
 * Equipos/operadores: SIEMPRE creados frescos por el test (nunca sembrados) —
 * mismo patrón que el resto de los e2e de este dominio (`RUN_ID`, agentes
 * logueados vía `POST /api/auth/sign-in/email`).
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
    'equipment-assignment.e2e-spec: SALTEADO (Postgres reachable=false) — levantar con ' +
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

maybeDescribe(
  'PATCH /api/equipment/:id/assignment — operadores del catálogo (e2e)',
  () => {
    jest.setTimeout(30_000);

    let app: NestExpressApplication;
    let prisma: PrismaService;

    let adminAgent: SupertestAgent;
    let supervisorAgent: SupertestAgent;
    let adminUserId: string;

    // `internalCode` tiene @MaxLength(20) — "EQA-" (4) + RUN_ID (5) + "-" (1)
    // = 10 chars fijos, deja 10 para el sufijo.
    const RUN_ID = randomUUID().slice(0, 5);
    const internalCode = (suffix: string) => `EQA-${RUN_ID}-${suffix}`;

    const createdEquipmentIds: string[] = [];

    beforeAll(async () => {
      ({ app, prisma } = await bootstrapApp());

      adminAgent = await loginAgent(app, 'admin@smi.local', SEED_PASSWORD);
      supervisorAgent = await loginAgent(
        app,
        'supervisor@smi.local',
        SEED_PASSWORD,
      );

      const adminUser = await prisma.user.findUniqueOrThrow({
        where: { email: 'admin@smi.local' },
        select: { id: true },
      });
      adminUserId = adminUser.id;
    });

    afterAll(async () => {
      if (createdEquipmentIds.length > 0) {
        await prisma.equipment.deleteMany({
          where: { id: { in: createdEquipmentIds } },
        });
      }
      await app.close();
    });

    describe('PATCH /api/equipment/:id/assignment', () => {
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
        operadorActivoId = (activoResponse.body as ApiEnvelope<OperatorData>)
          .data.id;
        operadoresParaLimpiar.push(operadorActivoId);

        const inactivoResponse = await adminAgent
          .post('/api/operators')
          .send({ name: `Operador Inactivo E2E ${RUN_ID}`, isActive: false })
          .expect(201);
        operadorInactivoId = (
          inactivoResponse.body as ApiEnvelope<OperatorData>
        ).data.id;
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
  },
);
