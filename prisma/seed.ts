/**
 * Seed de desarrollo. Tres partes:
 *  1. Usuarios (Better Auth): un usuario por rol vía `auth.api.createUser`
 *     (contraseña hasheada como Better Auth espera).
 *  2. Flota + Inventario (Amin): equipos con estados variados, insumos (algunos
 *     bajo mínimo) y movimientos que arman un kardex real.
 *  3. Operación en Terreno (Alexander): registros de ejemplo de sus 4 tablas,
 *     colgados de los equipos que siembra Flota.
 *
 * Reutiliza el MISMO singleton `prismaClient` que usa `auth.ts` (una sola pool),
 * y cierra la conexión explícitamente al final.
 */
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Branch,
  ControlUnit,
  Equipment,
  EquipmentClass,
  EquipmentStatus,
  OrigenMovimiento,
  TipoMovimiento,
  UnidadInsumo,
} from '@prisma/client';

import { prismaClient } from '../src/common/prisma/prisma.service';
import { auth } from '../src/auth/auth';
import { ROLES } from '../src/auth/roles';
import { InventarioService } from '../src/inventario/inventario.service';
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
  {
    name: 'Supervisor SMI',
    email: 'supervisor@smi.local',
    role: ROLES.SUPERVISOR,
  },
  {
    name: 'Mantenedor SMI',
    email: 'mantenedor@smi.local',
    role: ROLES.MANTENEDOR,
  },
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
}

// ============================================================================
// Flota (Benjamín) + Inventario (Joaquín)
// ============================================================================

/** Sucursales base (Plataforma/Benjamín) — homean a los equipos de Flota. */
const BRANCHES = [
  { name: 'Rajo Norte', address: 'Faena Rajo Norte, s/n' },
  { name: 'Rajo Sur', address: 'Faena Rajo Sur, s/n' },
];

/**
 * Índice (0-based) dentro de `BRANCHES` que homea a cada equipo, en el mismo
 * orden que `EQUIPOS`. `seedTerreno` sigue referenciando equipos por índice
 * (`equipos[0]`, `equipos[2]`…) — el orden/tamaño del arreglo no cambia.
 */
const HOME_BRANCH_INDEX = [0, 0, 0, 1, 1, 1, 0, 1] as const;

interface SeedEquipo {
  codigo: string;
  tipo: string;
  marca: string;
  modelo: string;
  anio: number;
  equipmentClass: EquipmentClass;
  controlUnit: ControlUnit;
  estado: EquipmentStatus;
  horometroActual: number | null;
  kilometrajeActual: number | null;
  /** Solo equipos que circulan por vía pública (camiones, camionetas…). */
  patente?: string;
}

const EQUIPOS: SeedEquipo[] = [
  {
    codigo: 'EX-001',
    tipo: 'Excavadora',
    marca: 'Caterpillar',
    modelo: '336',
    anio: 2019,
    equipmentClass: EquipmentClass.HEAVY,
    controlUnit: ControlUnit.HOURS,
    estado: EquipmentStatus.OPERATIONAL,
    horometroActual: 1200,
    kilometrajeActual: null,
  },
  {
    codigo: 'CG-002',
    tipo: 'Cargador',
    marca: 'Komatsu',
    modelo: 'WA320',
    anio: 2021,
    equipmentClass: EquipmentClass.HEAVY,
    controlUnit: ControlUnit.HOURS,
    estado: EquipmentStatus.OPERATIONAL,
    horometroActual: 800,
    kilometrajeActual: null,
  },
  {
    codigo: 'CM-003',
    tipo: 'Camión',
    marca: 'Volvo',
    modelo: 'FMX',
    anio: 2018,
    equipmentClass: EquipmentClass.HEAVY,
    controlUnit: ControlUnit.KM,
    estado: EquipmentStatus.IN_WORKSHOP,
    horometroActual: null,
    kilometrajeActual: 184300,
    patente: 'RTFG-32',
  },
  {
    codigo: 'PE-004',
    tipo: 'Perforadora',
    marca: 'Sandvik',
    modelo: 'DP1500',
    anio: 2016,
    equipmentClass: EquipmentClass.HEAVY,
    controlUnit: ControlUnit.HOURS,
    estado: EquipmentStatus.OUT_OF_SERVICE,
    horometroActual: 300,
    kilometrajeActual: null,
  },
  {
    codigo: 'BD-005',
    tipo: 'Bulldozer',
    marca: 'Caterpillar',
    modelo: 'D6',
    anio: 2020,
    equipmentClass: EquipmentClass.HEAVY,
    controlUnit: ControlUnit.HOURS,
    estado: EquipmentStatus.OPERATIONAL,
    horometroActual: 2100,
    kilometrajeActual: null,
  },
  {
    codigo: 'CM-006',
    tipo: 'Camión',
    marca: 'Scania',
    modelo: 'R450',
    anio: 2022,
    equipmentClass: EquipmentClass.HEAVY,
    controlUnit: ControlUnit.KM,
    estado: EquipmentStatus.OPERATIONAL,
    horometroActual: null,
    kilometrajeActual: 96500,
    patente: 'KGHJ-98',
  },
  {
    codigo: 'CN-007',
    tipo: 'Camioneta',
    marca: 'Toyota',
    modelo: 'Hilux',
    anio: 2023,
    equipmentClass: EquipmentClass.LIGHT,
    controlUnit: ControlUnit.KM,
    estado: EquipmentStatus.OPERATIONAL,
    horometroActual: null,
    kilometrajeActual: 15000,
    patente: 'ABCD-12',
  },
  {
    codigo: 'MB-008',
    tipo: 'Minibús',
    marca: 'Mercedes-Benz',
    modelo: 'Sprinter',
    anio: 2022,
    equipmentClass: EquipmentClass.LIGHT,
    controlUnit: ControlUnit.KM,
    estado: EquipmentStatus.OPERATIONAL,
    horometroActual: null,
    kilometrajeActual: 22000,
    patente: 'XXYY-34',
  },
];

/**
 * Insumos con su reposición inicial y sus consumos. Los números están elegidos
 * para que 4 de los 10 queden en o bajo su mínimo — la pantalla de Inventario
 * necesita mostrar la alerta de stock bajo con datos reales, no vacía.
 */
interface SeedInsumo {
  codigo: string;
  nombre: string;
  unidad: UnidadInsumo;
  stockMinimo: number;
  /** Reposición inicial (entrada por COMPRA). */
  entrada: number;
  /** Consumos posteriores: [cantidad, índice del equipo al que se imputa]. */
  consumos: ReadonlyArray<readonly [number, number]>;
}

const INSUMOS: readonly SeedInsumo[] = [
  {
    codigo: 'FIL-001',
    nombre: 'Filtro de aceite motor',
    unidad: UnidadInsumo.UNIDAD,
    stockMinimo: 10,
    entrada: 40,
    consumos: [
      [6, 0],
      [4, 2],
    ],
  },
  {
    codigo: 'FIL-002',
    nombre: 'Filtro de aire primario',
    unidad: UnidadInsumo.UNIDAD,
    stockMinimo: 8,
    entrada: 24,
    consumos: [[4, 1]],
  },
  {
    codigo: 'ACE-001',
    nombre: 'Aceite motor 15W-40',
    unidad: UnidadInsumo.LITRO,
    stockMinimo: 200,
    entrada: 400,
    consumos: [
      [120, 2],
      [60, 0],
    ],
  },
  {
    codigo: 'ACE-002',
    nombre: 'Aceite hidráulico ISO 68',
    unidad: UnidadInsumo.LITRO,
    stockMinimo: 150,
    entrada: 200,
    consumos: [
      [80, 0],
      [60, 3],
    ],
  },
  {
    codigo: 'REF-001',
    nombre: 'Refrigerante concentrado',
    unidad: UnidadInsumo.LITRO,
    stockMinimo: 40,
    entrada: 80,
    consumos: [[20, 5]],
  },
  {
    codigo: 'NEU-001',
    nombre: 'Neumático 29.5R25',
    unidad: UnidadInsumo.UNIDAD,
    stockMinimo: 4,
    entrada: 6,
    consumos: [[4, 1]],
  },
  {
    codigo: 'COR-001',
    nombre: 'Correa de alternador',
    unidad: UnidadInsumo.UNIDAD,
    stockMinimo: 5,
    entrada: 12,
    consumos: [[2, 4]],
  },
  {
    codigo: 'GRA-001',
    nombre: 'Grasa EP-2',
    unidad: UnidadInsumo.KILOGRAMO,
    stockMinimo: 25,
    entrada: 50,
    consumos: [[30, 4]],
  },
  {
    codigo: 'MAN-001',
    nombre: 'Manguera hidráulica 1/2"',
    unidad: UnidadInsumo.METRO,
    stockMinimo: 20,
    entrada: 60,
    consumos: [[18, 3]],
  },
  {
    codigo: 'BAT-001',
    nombre: 'Batería 12V 180Ah',
    unidad: UnidadInsumo.UNIDAD,
    stockMinimo: 2,
    entrada: 3,
    consumos: [[1, 5]],
  },
];

/** Siembra las sucursales base (Plataforma/Benjamín) que homean a la flota. */
async function seedBranches(): Promise<Branch[]> {
  const branches: Branch[] = [];
  for (const branch of BRANCHES) {
    branches.push(await prismaClient.branch.create({ data: branch }));
  }
  logger.log(`Plataforma: ${branches.length} sucursales`);
  return branches;
}

/**
 * Siembra flota e inventario y devuelve los equipos creados para que el seed de
 * Terreno cuelgue sus registros de ellos.
 *
 * Los movimientos se generan con el `InventarioService` REAL (reusando el
 * singleton `prismaClient`) en vez de insertarlos a mano: así el `stock` y el
 * `saldoResultante` del kardex salen del mismo código que corre en producción,
 * y no pueden quedar descuadrados por un error de aritmética en el seed.
 */
async function seedFlotaEInventario(
  adminId: string | null,
  branches: Branch[],
): Promise<Equipment[]> {
  // EventEmitter2 standalone: el seed no levanta la app Nest (no hay
  // NotificationsListener suscrito), así que los eventos de dominio que
  // dispare InventarioService acá simplemente no tienen listeners — no hace
  // falta el bus real de app.module.ts para que el seed compile ni corra.
  const inventario = new InventarioService(prismaClient, new EventEmitter2());

  const equipos: Equipment[] = [];
  for (const [index, equipo] of EQUIPOS.entries()) {
    equipos.push(
      await prismaClient.equipment.create({
        data: {
          internalCode: equipo.codigo,
          licensePlate: equipo.patente ?? null,
          type: equipo.tipo,
          brand: equipo.marca,
          model: equipo.modelo,
          year: equipo.anio,
          equipmentClass: equipo.equipmentClass,
          controlUnit: equipo.controlUnit,
          status: equipo.estado,
          currentHourmeter: equipo.horometroActual,
          currentMileage: equipo.kilometrajeActual,
          homeBranchId: branches[HOME_BRANCH_INDEX[index]].id,
        },
      }),
    );
  }

  for (const item of INSUMOS) {
    const insumo = await prismaClient.insumo.create({
      data: {
        codigo: item.codigo,
        nombre: item.nombre,
        unidad: item.unidad,
        stockMinimo: item.stockMinimo,
      },
    });

    await inventario.registrarEntrada({
      insumoId: insumo.id,
      cantidad: item.entrada,
      origen: OrigenMovimiento.COMPRA,
      responsableId: adminId,
      observacion: 'Reposición inicial de bodega',
    });

    for (const [cantidad, equipoIndex] of item.consumos) {
      await inventario.registrarSalida({
        insumoId: insumo.id,
        cantidad,
        origen: OrigenMovimiento.INTERVENCION,
        responsableId: adminId,
        equipoId: equipos[equipoIndex].id,
        observacion: `Consumo en mantención de ${equipos[equipoIndex].internalCode}`,
      });
    }
  }

  // Un par de movimientos de los otros tipos, para que el kardex de la demo no
  // sea solo compras y consumos.
  const grasa = await prismaClient.insumo.findUniqueOrThrow({
    where: { codigo: 'GRA-001' },
  });
  await inventario.registrarEntrada({
    insumoId: grasa.id,
    cantidad: 5,
    origen: OrigenMovimiento.DEVOLUCION,
    responsableId: adminId,
    observacion: 'Material no utilizado devuelto a bodega',
  });

  const refrigerante = await prismaClient.insumo.findUniqueOrThrow({
    where: { codigo: 'REF-001' },
  });
  await inventario.ajustarPorConteo({
    insumoId: refrigerante.id,
    stockContado: 57,
    responsableId: adminId,
  });

  const bajoMinimo = await prismaClient.insumo.count({
    where: { stock: { lte: prismaClient.insumo.fields.stockMinimo } },
  });

  logger.log(
    `Flota + Inventario: ${equipos.length} equipos, ${INSUMOS.length} insumos (${bajoMinimo} bajo mínimo)`,
  );

  return equipos;
}

// ============================================================================
// Operación en Terreno (Alexander) — cuelga de los equipos de Flota
// ============================================================================

async function seedTerreno(equipos: Equipment[]): Promise<void> {
  await prismaClient.registroCombustible.createMany({
    data: [
      { equipoId: equipos[0].id, litros: 120, tipo: 'PETROLEO' },
      { equipoId: equipos[1].id, litros: 90, tipo: 'PETROLEO' },
      { equipoId: equipos[5].id, litros: 45, tipo: 'BENCINA' },
    ],
  });

  await prismaClient.registroHorometro.createMany({
    data: [
      {
        equipoId: equipos[0].id,
        operador: 'Juan Rojas',
        turno: 'DIURNO',
        valorInicial: 1180,
        valorFinal: 1200,
        nivelCombustible: 75,
      },
      {
        equipoId: equipos[1].id,
        operador: 'Marcela Díaz',
        turno: 'NOCTURNO',
        valorInicial: 790,
        valorFinal: 800,
        nivelCombustible: 40,
      },
    ],
  });

  await prismaClient.trabajoExtraordinario.createMany({
    data: [
      {
        equipoId: equipos[2].id,
        operador: 'Juan Rojas',
        faena: 'Rajo Norte',
        turno: 'DIURNO',
        horometroInicial: 5388,
        horometroFinal: 5400,
        totalHoras: 12,
        actividad: 'REGULACION_CARGA',
        descripcion: 'Regulación y carga de material en frente 3.',
        observaciones: 'Sin novedades.',
      },
      {
        equipoId: equipos[5].id,
        operador: 'Pedro Soto',
        faena: 'Rajo Sur',
        turno: 'NOCTURNO',
        horometroInicial: 3292,
        horometroFinal: 3300,
        totalHoras: 8,
        actividad: 'LIMPIEZA_CANCHA',
        descripcion: 'Limpieza de cancha de acopio.',
        observaciones: null,
      },
    ],
  });

  await prismaClient.hallazgo.createMany({
    data: [
      {
        equipoId: equipos[3].id,
        descripcion: 'Fuga de aceite hidráulico en cilindro de levante',
        prioridad: 'ALTA',
        estado: 'ABIERTO',
      },
      {
        equipoId: equipos[0].id,
        descripcion: 'Ruido anormal en motor al acelerar en vacío',
        prioridad: 'MEDIA',
        estado: 'EN_PROCESO',
      },
      {
        equipoId: equipos[2].id,
        descripcion: 'Frenos con baja respuesta — equipo fuera de servicio',
        prioridad: 'CRITICA',
        estado: 'ABIERTO',
      },
    ],
  });

  logger.log(
    'Terreno: registros de combustible, horómetro, trabajos y hallazgos',
  );
}

/**
 * Borra los datos de dominio en orden de dependencia (hijos antes que padres):
 * todo cuelga de `Equipment`, y `Equipment` a su vez cuelga de `Branch`
 * (`homeBranchId`), así que van últimos en ese orden. Vive acá y no dentro de
 * cada `seedX` porque el orden correcto cruza los dominios y hacerlo por
 * partes obligaba a que Flota borrara tablas de Terreno o al revés.
 *
 * No toca las tablas de Better Auth: los usuarios se crean de forma idempotente
 * (`seedUsers` omite los que ya existen).
 */
async function limpiarDatosDeDominio(): Promise<void> {
  await prismaClient.movimientoInventario.deleteMany();
  await prismaClient.insumo.deleteMany();
  await prismaClient.registroCombustible.deleteMany();
  await prismaClient.registroHorometro.deleteMany();
  await prismaClient.trabajoExtraordinario.deleteMany();
  await prismaClient.hallazgo.deleteMany();
  await prismaClient.equipment.deleteMany();
  await prismaClient.branch.deleteMany();
}

async function seed(): Promise<void> {
  // A2 (auditoría de seguridad): el seed crea usuarios con contraseña de
  // desarrollo conocida — nunca debe poder correr contra un entorno de
  // producción, sin importar quién lo dispare.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Seed with dev credentials must NOT run in production');
  }

  await seedUsers();
  await limpiarDatosDeDominio();

  // Los movimientos de inventario quedan imputados al admin del seed, para que
  // la columna "responsable" del kardex no salga vacía en la demo.
  const admin = await prismaClient.user.findUnique({
    where: { email: 'admin@smi.local' },
    select: { id: true },
  });

  // Flota depende de Plataforma (homeBranch); Terreno depende de Flota: se
  // crean en ese orden y se pasan los resultados hacia abajo.
  const branches = await seedBranches();
  const equipos = await seedFlotaEInventario(admin?.id ?? null, branches);
  await seedTerreno(equipos);

  // Dominio Mantenimiento (Joaquín): corre al final; resuelve el asignadoAId
  // buscando al mantenedor seed por email. No depende de Flota/Terreno (soft refs).
  await seedMantenimiento();
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
