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
      { equipoId: equipos[0].id, litros: 120, rendimiento: 4.5 },
      { equipoId: equipos[1].id, litros: 90, rendimiento: 5.1 },
      { equipoId: equipos[5].id, litros: 200, rendimiento: 3.8 },
    ],
  });

  await prisma.registroHorometro.createMany({
    data: [
      { equipoId: equipos[0].id, operadorId: 'user-operador-1', turno: 'MANANA', valorInicial: 1180, valorFinal: 1200 },
      { equipoId: equipos[1].id, operadorId: 'user-operador-2', turno: 'TARDE', valorInicial: 790, valorFinal: 800 },
    ],
  });

  await prisma.trabajoExtraordinario.createMany({
    data: [
      { equipoId: equipos[2].id, cliente: 'Minera Norte', horasMaquina: 12, tonelaje: 340, tarifa: 85000, monto: 1020000 },
      { equipoId: equipos[5].id, cliente: 'Áridos Sur', horasMaquina: 8, tonelaje: 210, tarifa: 70000, monto: 560000 },
    ],
  });

  await prisma.hallazgo.createMany({
    data: [
      { equipoId: equipos[3].id, descripcion: 'Fuga de aceite hidráulico', criticidad: 'ALTA', estado: 'ABIERTO' },
      { equipoId: equipos[0].id, descripcion: 'Ruido anormal en el motor', criticidad: 'MEDIA', estado: 'EN_PROCESO' },
      { equipoId: equipos[2].id, descripcion: 'Frenos con baja respuesta', criticidad: 'CRITICA', estado: 'ABIERTO' },
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
