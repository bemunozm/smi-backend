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
  Equipo,
  EstadoEquipo,
  OrigenMovimiento,
  Sucursal,
  TipoInsumo,
  UnidadInsumo,
} from '@prisma/client';

import { prismaClient } from '../src/common/prisma/prisma.service';
import { auth } from '../src/auth/auth';
import { ROLES } from '../src/auth/roles';
import { InventarioService } from '../src/inventario/inventario.service';
import { SucursalesService } from '../src/sucursales/sucursales.service';
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
// Flota + Inventario (Amin)
// ============================================================================

const EQUIPOS = [
  {
    codigo: 'EX-001',
    tipo: 'Excavadora',
    marca: 'Caterpillar',
    modelo: '336',
    anio: 2019,
    estado: EstadoEquipo.DISPONIBLE,
    horometroActual: 1200,
    kilometrajeActual: 0,
  },
  {
    codigo: 'CG-002',
    tipo: 'Cargador',
    marca: 'Komatsu',
    modelo: 'WA320',
    anio: 2021,
    estado: EstadoEquipo.DISPONIBLE,
    horometroActual: 800,
    kilometrajeActual: 0,
  },
  {
    codigo: 'CM-003',
    tipo: 'Camión',
    marca: 'Volvo',
    modelo: 'FMX',
    anio: 2018,
    estado: EstadoEquipo.EN_MANTENCION,
    horometroActual: 5400,
    kilometrajeActual: 184300,
  },
  {
    codigo: 'PE-004',
    tipo: 'Perforadora',
    marca: 'Sandvik',
    modelo: 'DP1500',
    anio: 2016,
    estado: EstadoEquipo.DE_BAJA,
    horometroActual: 300,
    kilometrajeActual: 0,
  },
  {
    codigo: 'BD-005',
    tipo: 'Bulldozer',
    marca: 'Caterpillar',
    modelo: 'D6',
    anio: 2020,
    estado: EstadoEquipo.DISPONIBLE,
    horometroActual: 2100,
    kilometrajeActual: 0,
  },
  {
    codigo: 'CM-006',
    tipo: 'Camión',
    marca: 'Scania',
    modelo: 'R450',
    anio: 2022,
    estado: EstadoEquipo.EN_RUTA,
    horometroActual: 3300,
    kilometrajeActual: 96500,
  },
  {
    // Gemelo de EX-001 (misma marca y modelo) y SIN compatibilidades propias:
    // es el caso que hace visible el aviso "copiá las de EX-001" de RFC-12 §4.
    codigo: 'EX-007',
    tipo: 'Excavadora',
    marca: 'Caterpillar',
    modelo: '336',
    anio: 2023,
    estado: EstadoEquipo.DISPONIBLE,
    horometroActual: 150,
    kilometrajeActual: 0,
  },
];

/**
 * Compatibilidad repuesto ↔ equipo (RFC-12): qué le sirve a cada máquina.
 * `[código de equipo, código de insumo, nota]`.
 */
const COMPATIBILIDADES: ReadonlyArray<
  readonly [string, string, string | null]
> = [
  ['EX-001', 'FIL-001', null],
  ['EX-001', 'FIL-002', null],
  ['EX-001', 'ACE-001', null],
  ['EX-001', 'ACE-002', 'Sistema hidráulico principal'],
  ['EX-001', 'MAN-001', 'Tramo del brazo, medir antes de cortar'],
  ['CG-002', 'FIL-001', null],
  ['CG-002', 'ACE-001', null],
  ['CG-002', 'COR-001', null],
  ['CM-003', 'FIL-002', null],
  ['CM-003', 'BAT-001', null],
  // Existe solo en Faena Norte: en Casa Matriz aparece como "en otra sucursal".
  ['CM-003', 'NEU-001', 'Solo eje trasero'],
  ['BD-005', 'FIL-001', null],
  ['BD-005', 'ACE-002', null],
  ['BD-005', 'GRA-001', 'Engrase de cadenas cada 250 h'],
];

/**
 * Bodegas de la demo (RFC-11). La primera es la principal: es la que reciben
 * los movimientos que llegan sin sucursal explícita.
 */
const SUCURSALES = [
  {
    codigo: 'CENTRAL',
    nombre: 'Casa Matriz',
    direccion: 'Av. Pedro de Valdivia 1200, Antofagasta',
    esPrincipal: true,
  },
  {
    codigo: 'FAENA',
    nombre: 'Faena Norte',
    direccion: 'Ruta 5 Norte km 1420, Calama',
    esPrincipal: false,
  },
] as const;

/**
 * Insumos con su reposición inicial y sus consumos. Los números están elegidos
 * para que 4 de los 10 queden en o bajo su mínimo GLOBAL — la pantalla de
 * Inventario necesita mostrar la alerta de stock bajo con datos reales, no vacía.
 *
 * `reparto` distribuye esa misma reposición entre las dos bodegas (en el orden
 * de `SUCURSALES`: casa matriz y faena), así la pantalla de stock por sucursal
 * también tiene algo que mostrar: hay repuestos que existen en la empresa pero
 * NO en la bodega donde está el mantenedor, que es justo el caso que motiva
 * PROD-11.
 */
interface SeedInsumo {
  codigo: string;
  nombre: string;
  unidad: UnidadInsumo;
  tipo: TipoInsumo;
  stockMinimo: number;
  /** Reposición inicial por bodega (COMPRA). Suma = reposición total. */
  reparto: readonly [number, number];
  /**
   * Umbral de reposición PROPIO de cada bodega. `0` = esa bodega no fija uno y
   * por lo tanto no alerta (el mínimo global es de la empresa, no de la
   * bodega — ver `evaluarMinimoBodega`).
   */
  minimos: readonly [number, number];
  /** Consumos posteriores: [cantidad, índice de equipo, índice de sucursal]. */
  consumos: ReadonlyArray<readonly [number, number, number]>;
}

const INSUMOS: readonly SeedInsumo[] = [
  {
    codigo: 'FIL-001',
    nombre: 'Filtro de aceite motor',
    unidad: UnidadInsumo.UNIDAD,
    tipo: TipoInsumo.REPUESTO,
    stockMinimo: 10,
    reparto: [20, 20],
    minimos: [8, 25],
    consumos: [
      [6, 0, 0],
      [4, 2, 0],
    ],
  },
  {
    codigo: 'FIL-002',
    nombre: 'Filtro de aire primario',
    unidad: UnidadInsumo.UNIDAD,
    tipo: TipoInsumo.REPUESTO,
    stockMinimo: 8,
    reparto: [12, 12],
    minimos: [10, 0],
    consumos: [[4, 1, 0]],
  },
  {
    codigo: 'ACE-001',
    nombre: 'Aceite motor 15W-40',
    unidad: UnidadInsumo.LITRO,
    tipo: TipoInsumo.SUMINISTRO,
    stockMinimo: 200,
    reparto: [220, 180],
    minimos: [30, 100],
    consumos: [
      [120, 2, 0],
      [60, 0, 0],
    ],
  },
  {
    codigo: 'ACE-002',
    nombre: 'Aceite hidráulico ISO 68',
    unidad: UnidadInsumo.LITRO,
    tipo: TipoInsumo.SUMINISTRO,
    stockMinimo: 150,
    reparto: [150, 50],
    minimos: [0, 0],
    consumos: [
      [80, 0, 0],
      [60, 3, 0],
    ],
  },
  {
    codigo: 'REF-001',
    nombre: 'Refrigerante concentrado',
    unidad: UnidadInsumo.LITRO,
    tipo: TipoInsumo.SUMINISTRO,
    stockMinimo: 40,
    reparto: [50, 30],
    minimos: [20, 0],
    consumos: [[20, 5, 0]],
  },
  {
    // Cero en la casa matriz y con existencia solo en la faena: es el caso que
    // hace visible el problema que resuelve PROD-11 ("sirve, pero no está acá").
    codigo: 'NEU-001',
    nombre: 'Neumático 29.5R25',
    unidad: UnidadInsumo.UNIDAD,
    tipo: TipoInsumo.REPUESTO,
    stockMinimo: 4,
    reparto: [4, 2],
    minimos: [1, 1],
    consumos: [[4, 1, 0]],
  },
  {
    codigo: 'COR-001',
    nombre: 'Correa de alternador',
    unidad: UnidadInsumo.UNIDAD,
    tipo: TipoInsumo.REPUESTO,
    stockMinimo: 5,
    reparto: [6, 6],
    minimos: [5, 0],
    consumos: [[2, 4, 0]],
  },
  {
    codigo: 'GRA-001',
    nombre: 'Grasa EP-2',
    unidad: UnidadInsumo.KILOGRAMO,
    tipo: TipoInsumo.SUMINISTRO,
    stockMinimo: 25,
    reparto: [35, 15],
    minimos: [0, 0],
    consumos: [[30, 4, 0]],
  },
  {
    codigo: 'MAN-001',
    nombre: 'Manguera hidráulica 1/2"',
    unidad: UnidadInsumo.METRO,
    tipo: TipoInsumo.REPUESTO,
    stockMinimo: 20,
    reparto: [30, 30],
    minimos: [10, 0],
    consumos: [[18, 3, 0]],
  },
  {
    codigo: 'BAT-001',
    nombre: 'Batería 12V 180Ah',
    unidad: UnidadInsumo.UNIDAD,
    tipo: TipoInsumo.REPUESTO,
    stockMinimo: 2,
    reparto: [3, 0],
    minimos: [2, 0],
    consumos: [[1, 5, 0]],
  },
];

/**
 * Siembra flota e inventario y devuelve los equipos creados para que el seed de
 * Terreno cuelgue sus registros de ellos.
 *
 * Los movimientos se generan con el `InventarioService` REAL (reusando el
 * singleton `prismaClient`) en vez de insertarlos a mano: así el `stock` y el
 * `saldoResultante` del kardex salen del mismo código que corre en producción,
 * y no pueden quedar descuadrados por un error de aritmética en el seed.
 */
async function seedFlotaEInventario(adminId: string | null): Promise<Equipo[]> {
  // EventEmitter2 standalone: el seed no levanta la app Nest (no hay
  // NotificationsListener suscrito), así que los eventos de dominio que
  // dispare InventarioService acá simplemente no tienen listeners — no hace
  // falta el bus real de app.module.ts para que el seed compile ni corra.
  const sucursalesService = new SucursalesService(prismaClient);
  const inventario = new InventarioService(
    prismaClient,
    new EventEmitter2(),
    sucursalesService,
  );

  // Las bodegas se crean ANTES que cualquier insumo: todo movimiento necesita
  // una sucursal, y sin ninguna registrada el service falla explícitamente.
  // Va por `upsert` y no por `create` porque la migración
  // `20260908120000_inventario_por_sucursal` ya deja insertada la sucursal
  // CENTRAL para respaldar las filas existentes: con `create` el seed reventaba
  // con P2002 sobre `codigo` en cualquier base recién migrada.
  const sucursales: Sucursal[] = [];
  for (const sucursal of SUCURSALES) {
    sucursales.push(
      await prismaClient.sucursal.upsert({
        where: { codigo: sucursal.codigo },
        update: sucursal,
        create: sucursal,
      }),
    );
  }

  // Bodegas que ya no figuran en el catálogo de arriba (p. ej. al reducir las
  // sucursales de la demo): se eliminan para que el seed CONVERJA a
  // `SUCURSALES` en vez de ir acumulando restos de corridas anteriores. Es
  // seguro acá porque `limpiarDatosDeDominio()` ya borró los movimientos, que
  // son los únicos que referencian una sucursal con `onDelete: Restrict`.
  await prismaClient.sucursal.deleteMany({
    where: { codigo: { notIn: SUCURSALES.map((s) => s.codigo) } },
  });

  const equipos: Equipo[] = [];
  for (const equipo of EQUIPOS) {
    equipos.push(await prismaClient.equipo.create({ data: equipo }));
  }

  for (const item of INSUMOS) {
    const insumo = await prismaClient.insumo.create({
      data: {
        codigo: item.codigo,
        nombre: item.nombre,
        unidad: item.unidad,
        tipo: item.tipo,
        stockMinimo: item.stockMinimo,
      },
    });

    for (const [indice, cantidad] of item.reparto.entries()) {
      if (cantidad === 0) continue;
      await inventario.registrarEntrada({
        insumoId: insumo.id,
        cantidad,
        origen: OrigenMovimiento.COMPRA,
        sucursalId: sucursales[indice].id,
        responsableId: adminId,
        observacion: `Reposición inicial de ${sucursales[indice].nombre}`,
      });
    }

    // Umbrales por bodega. Van con `upsert` porque configurar el mínimo ANTES
    // de que llegue el primer repuesto es un caso válido (la fila de saldo
    // todavía puede no existir).
    for (const [indice, minimo] of item.minimos.entries()) {
      if (minimo === 0) continue;
      await prismaClient.stockSucursal.upsert({
        where: {
          insumoId_sucursalId: {
            insumoId: insumo.id,
            sucursalId: sucursales[indice].id,
          },
        },
        update: { stockMinimo: minimo },
        create: {
          insumoId: insumo.id,
          sucursalId: sucursales[indice].id,
          stock: 0,
          stockMinimo: minimo,
        },
      });
    }

    for (const [cantidad, equipoIndex, sucursalIndex] of item.consumos) {
      await inventario.registrarSalida({
        insumoId: insumo.id,
        cantidad,
        origen: OrigenMovimiento.INTERVENCION,
        sucursalId: sucursales[sucursalIndex].id,
        responsableId: adminId,
        equipoId: equipos[equipoIndex].id,
        observacion: `Consumo en mantención de ${equipos[equipoIndex].codigo}`,
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
    sucursalId: sucursales[0].id,
    responsableId: adminId,
    observacion: 'Material no utilizado devuelto a bodega',
  });

  const refrigerante = await prismaClient.insumo.findUniqueOrThrow({
    where: { codigo: 'REF-001' },
  });
  // El conteo físico es de UNA bodega: se cuenta lo que hay en Casa Matriz
  // (30 según el sistema), no el total de la empresa.
  await inventario.ajustarPorConteo({
    insumoId: refrigerante.id,
    stockContado: 27,
    sucursalId: sucursales[0].id,
    responsableId: adminId,
  });

  const bajoMinimo = await prismaClient.insumo.count({
    where: { stock: { lte: prismaClient.insumo.fields.stockMinimo } },
  });

  // Compatibilidades (RFC-12). Se resuelven por código para que la lista de
  // arriba se lea como la escribiría un mecánico, no como una lista de ids.
  const porCodigoEquipo = new Map(equipos.map((eq) => [eq.codigo, eq.id]));
  const insumosPorCodigo = new Map(
    (
      await prismaClient.insumo.findMany({ select: { id: true, codigo: true } })
    ).map((ins) => [ins.codigo, ins.id]),
  );

  for (const [codigoEquipo, codigoInsumo, nota] of COMPATIBILIDADES) {
    const equipoId = porCodigoEquipo.get(codigoEquipo);
    const insumoId = insumosPorCodigo.get(codigoInsumo);
    if (!equipoId || !insumoId) {
      throw new Error(
        `Compatibilidad inválida en el seed: ${codigoEquipo} ↔ ${codigoInsumo}`,
      );
    }
    await prismaClient.compatibilidadEquipoInsumo.create({
      data: { equipoId, insumoId, nota, declaradaPorId: adminId },
    });
  }

  // Verificación de la invariante de RFC-11 §5.2 sobre datos reales: si el seed
  // la rompe, el resto de la demo trabaja sobre números que no cuadran.
  const totales = await prismaClient.stockSucursal.groupBy({
    by: ['insumoId'],
    _sum: { stock: true },
  });
  const insumos = await prismaClient.insumo.findMany({
    select: { id: true, codigo: true, stock: true },
  });
  const descuadres = insumos.filter((insumo) => {
    const suma =
      totales.find((fila) => fila.insumoId === insumo.id)?._sum.stock ?? 0;
    return Math.abs(suma - insumo.stock) > 1e-9;
  });
  if (descuadres.length > 0) {
    throw new Error(
      `El stock total no cuadra con la suma por sucursal en: ${descuadres
        .map((insumo) => insumo.codigo)
        .join(', ')}`,
    );
  }

  logger.log(
    `Flota + Inventario: ${equipos.length} equipos, ${sucursales.length} sucursales, ${INSUMOS.length} insumos (${bajoMinimo} bajo mínimo global), ${COMPATIBILIDADES.length} compatibilidades`,
  );

  return equipos;
}

// ============================================================================
// Operación en Terreno (Alexander) — cuelga de los equipos de Flota
// ============================================================================

async function seedTerreno(equipos: Equipo[]): Promise<void> {
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
 * todo cuelga de `Equipo`, así que va último. Vive acá y no dentro de cada
 * `seedX` porque el orden correcto cruza los dominios y hacerlo por partes
 * obligaba a que Flota borrara tablas de Terreno o al revés.
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
  await prismaClient.equipo.deleteMany();
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

  // Terreno depende de Flota: los equipos se crean primero y se pasan.
  const equipos = await seedFlotaEInventario(admin?.id ?? null);
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
