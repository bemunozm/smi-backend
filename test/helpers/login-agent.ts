import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { env } from '../../src/common/config/env';

/** Password de TODOS los usuarios sembrados (`prisma/seed.ts`) — compartida
 * por los e2e que loguean contra el seed. */
export const SEED_PASSWORD = 'Smi123456!';

export type SupertestAgent = ReturnType<typeof request.agent>;

/** Login real vía `POST /api/auth/sign-in/email` (Better Auth) — el agente de
 * supertest conserva la cookie de sesión entre requests, así que los tests
 * pueden encadenar llamadas autenticadas sin repetir el login. */
export async function loginAgent(
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
