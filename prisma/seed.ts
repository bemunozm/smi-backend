import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // PROVISIONAL — los equipos normalmente los siembra Amin (Flota).
  const equiposData = [
    { codigo: 'EX-001', tipo: 'Excavadora', marca: 'Caterpillar', modelo: '336', estado: 'OPERATIVO', horometroActual: 1200, kilometrajeActual: 0 },
    { codigo: 'CG-002', tipo: 'Cargador', marca: 'Komatsu', modelo: 'WA320', estado: 'OPERATIVO', horometroActual: 800, kilometrajeActual: 0 },
    { codigo: 'CM-003', tipo: 'Camión', marca: 'Volvo', modelo: 'FMX', estado: 'MANTENIMIENTO', horometroActual: 5400, kilometrajeActual: 82000 },
    { codigo: 'PE-004', tipo: 'Perforadora', marca: 'Sandvik', modelo: 'DP1500', estado: 'DETENIDO', horometroActual: 300, kilometrajeActual: 0 },
    { codigo: 'BD-005', tipo: 'Bulldozer', marca: 'Caterpillar', modelo: 'D6', estado: 'OPERATIVO', horometroActual: 2100, kilometrajeActual: 0 },
    { codigo: 'CM-006', tipo: 'Camión', marca: 'Scania', modelo: 'R450', estado: 'OPERATIVO', horometroActual: 3300, kilometrajeActual: 51000 },
  ];

  await prisma.registroCombustible.deleteMany();
  await prisma.registroHorometro.deleteMany();
  await prisma.trabajoExtraordinario.deleteMany();
  await prisma.hallazgo.deleteMany();
  await prisma.equipo.deleteMany();

  const equipos: { id: string }[] = [];
  for (const e of equiposData) equipos.push(await prisma.equipo.create({ data: e }));

  await prisma.registroCombustible.createMany({
    data: [
      { equipoId: equipos[0].id, litros: 120, tipo: 'PETROLEO' },
      { equipoId: equipos[1].id, litros: 90, tipo: 'PETROLEO' },
      { equipoId: equipos[5].id, litros: 45, tipo: 'BENCINA' },
    ],
  });

  await prisma.registroHorometro.createMany({
    data: [
      { equipoId: equipos[0].id, operador: 'Juan Rojas', turno: 'DIURNO', valorInicial: 1180, valorFinal: 1200, nivelCombustible: 75 },
      { equipoId: equipos[1].id, operador: 'Marcela Díaz', turno: 'NOCTURNO', valorInicial: 790, valorFinal: 800, nivelCombustible: 40 },
    ],
  });

  await prisma.trabajoExtraordinario.createMany({
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

  await prisma.hallazgo.createMany({
    data: [
      { equipoId: equipos[3].id, descripcion: 'Fuga de aceite hidráulico en cilindro de levante', prioridad: 'ALTA', estado: 'ABIERTO' },
      { equipoId: equipos[0].id, descripcion: 'Ruido anormal en motor al acelerar en vacío', prioridad: 'MEDIA', estado: 'EN_PROCESO' },
      { equipoId: equipos[2].id, descripcion: 'Frenos con baja respuesta — equipo fuera de servicio', prioridad: 'CRITICA', estado: 'ABIERTO' },
    ],
  });

  console.log('Seed completado.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
