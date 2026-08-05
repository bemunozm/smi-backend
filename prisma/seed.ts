/**
 * Seed de desarrollo. Dos partes:
 *  1. Usuarios (Better Auth): un usuario por rol vía `auth.api.createUser`
 *     (contraseña hasheada como Better Auth espera).
 *  2. Operación en Terreno (Alexander): equipos PROVISIONALES (dueño real:
 *     Amin/Flota) + registros de ejemplo de las 4 tablas del dominio.
 *
 * Reutiliza el MISMO singleton `prismaClient` que usa `auth.ts` (una sola pool),
 * y cierra la conexión explícitamente al final.
 */
import { Logger } from '@nestjs/common';

import { prismaClient } from '../src/common/prisma/prisma.service';
import { auth } from '../src/auth/auth';
import { ROLES } from '../src/auth/roles';
import { seedMantenimiento } from './seeds/mantenimiento.seed';

const logger = new Logger('Seed');

const SEED_PASSWORD = 'Smi123456!';

interface SeedUser {
  name: string;
  email: string;
  role: (typeof ROLES)[keyof typeof ROLES];
}

const SEED_USERS: SeedUser[] = [
  { name: 'Admin SMI', email: 'admin@smi.local', role: ROLES.ADMIN },
  { name: 'Supervisor SMI', email: 'supervisor@smi.local', role: ROLES.SUPERVISOR },
  { name: 'Mantenedor SMI', email: 'mantenedor@smi.local', role: ROLES.MANTENEDOR },
  { name: 'Operador SMI', email: 'operador@smi.local', role: ROLES.OPERADOR },
];

function isUserAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'body' in error &&
    typeof (error as { body?: unknown }).body === 'object' &&
    (error as { body?: { code?: string } }).body?.code ===
      'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'
  );
}

async function seedUsers(): Promise<void> {
  for (const seedUser of SEED_USERS) {
    try {
      await auth.api.createUser({
        body: {
          email: seedUser.email,
          password: SEED_PASSWORD,
          name: seedUser.name,
          role: seedUser.role,
        },
      });
      logger.log(`Usuario creado: ${seedUser.email} (${seedUser.role})`);
    } catch (error) {
      if (isUserAlreadyExistsError(error)) {
        logger.warn(`Ya existía, se omite: ${seedUser.email}`);
        continue;
      }
      throw error;
    }
  }

  // Dominio Mantenimiento (Joaquín): corre DESPUÉS de los usuarios porque
  // resuelve el `asignadoAId` de sus OTs/actividades buscando al mantenedor
  // seed por email.
  await seedMantenimiento();
}

// PROVISIONAL — normalmente los equipos los siembra Amin (Flota).
const EQUIPOS = [
  { codigo: 'EX-001', tipo: 'Excavadora', marca: 'Caterpillar', modelo: '336', estado: 'OPERATIVO', horometroActual: 1200 },
  { codigo: 'CG-002', tipo: 'Cargador', marca: 'Komatsu', modelo: 'WA320', estado: 'OPERATIVO', horometroActual: 800 },
  { codigo: 'CM-003', tipo: 'Camión', marca: 'Volvo', modelo: 'FMX', estado: 'MANTENIMIENTO', horometroActual: 5400 },
  { codigo: 'PE-004', tipo: 'Perforadora', marca: 'Sandvik', modelo: 'DP1500', estado: 'DETENIDO', horometroActual: 300 },
  { codigo: 'BD-005', tipo: 'Bulldozer', marca: 'Caterpillar', modelo: 'D6', estado: 'OPERATIVO', horometroActual: 2100 },
  { codigo: 'CM-006', tipo: 'Camión', marca: 'Scania', modelo: 'R450', estado: 'OPERATIVO', horometroActual: 3300 },
];

async function seedTerreno(): Promise<void> {
  await prismaClient.registroCombustible.deleteMany();
  await prismaClient.registroHorometro.deleteMany();
  await prismaClient.trabajoExtraordinario.deleteMany();
  await prismaClient.hallazgo.deleteMany();
  await prismaClient.equipo.deleteMany();

  const equipos: { id: string }[] = [];
  for (const e of EQUIPOS) equipos.push(await prismaClient.equipo.create({ data: e }));

  await prismaClient.registroCombustible.createMany({
    data: [
      { equipoId: equipos[0].id, litros: 120, tipo: 'PETROLEO' },
      { equipoId: equipos[1].id, litros: 90, tipo: 'PETROLEO' },
      { equipoId: equipos[5].id, litros: 45, tipo: 'BENCINA' },
    ],
  });

  await prismaClient.registroHorometro.createMany({
    data: [
      { equipoId: equipos[0].id, operador: 'Juan Rojas', turno: 'DIURNO', valorInicial: 1180, valorFinal: 1200, nivelCombustible: 75 },
      { equipoId: equipos[1].id, operador: 'Marcela Díaz', turno: 'NOCTURNO', valorInicial: 790, valorFinal: 800, nivelCombustible: 40 },
    ],
  });

  await prismaClient.trabajoExtraordinario.createMany({
    data: [
      { equipoId: equipos[2].id, operador: 'Juan Rojas', faena: 'Rajo Norte', turno: 'DIURNO', horometroInicial: 5388, horometroFinal: 5400, totalHoras: 12, actividad: 'REGULACION_CARGA', descripcion: 'Regulación y carga de material en frente 3.', observaciones: 'Sin novedades.' },
      { equipoId: equipos[5].id, operador: 'Pedro Soto', faena: 'Rajo Sur', turno: 'NOCTURNO', horometroInicial: 3292, horometroFinal: 3300, totalHoras: 8, actividad: 'LIMPIEZA_CANCHA', descripcion: 'Limpieza de cancha de acopio.', observaciones: null },
    ],
  });

  await prismaClient.hallazgo.createMany({
    data: [
      { equipoId: equipos[3].id, descripcion: 'Fuga de aceite hidráulico en cilindro de levante', prioridad: 'ALTA', estado: 'ABIERTO' },
      { equipoId: equipos[0].id, descripcion: 'Ruido anormal en motor al acelerar en vacío', prioridad: 'MEDIA', estado: 'EN_PROCESO' },
      { equipoId: equipos[2].id, descripcion: 'Frenos con baja respuesta — equipo fuera de servicio', prioridad: 'CRITICA', estado: 'ABIERTO' },
    ],
  });

  logger.log(`Terreno: ${equipos.length} equipos + registros de ejemplo`);
}

async function seed(): Promise<void> {
  // A2 (auditoría de seguridad): el seed crea usuarios con contraseña de
  // desarrollo conocida — nunca debe poder correr contra un entorno de
  // producción, sin importar quién lo dispare.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Seed with dev credentials must NOT run in production');
  }

  await seedUsers();
  await seedTerreno();
}

void seed()
  .then(() => {
    logger.log('Seed completado.');
  })
  .catch((error: unknown) => {
    logger.error('Error ejecutando el seed', error as Error);
    process.exitCode = 1;
  })
  .finally(() => prismaClient.$disconnect());
