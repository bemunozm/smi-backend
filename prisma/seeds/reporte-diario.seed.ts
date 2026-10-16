import { Logger } from '@nestjs/common';

import { prismaClient } from '../../src/common/prisma/prisma.service';

const logger = new Logger('SeedReporteDiario');

/** Las diez plantas y apoyos, en el orden de pantalla de la maqueta. */
const PLANTAS = [
  'P.P.1',
  'P.P.2',
  'P.R.2',
  'P.P.4',
  'P.R.4',
  'Apoyo piso Mina-Puerto',
  'Apoyo piso externos',
  'Producto Camino',
  'Producto Fino',
  'Planta P.P.E',
];

/** Solo las 4 confirmadas; RT y Spence siguen en duda (Q8 del Acta N.° 006). */
const EMPRESAS = ['Hyd', 'Casa Blanca', 'Coseducam', 'Sijam'];

/** Idempotente: upsert por nombre, se puede correr las veces que sea. */
export async function seedReporteDiarioCatalogos(): Promise<void> {
  for (const [i, nombre] of PLANTAS.entries()) {
    await prismaClient.planta.upsert({
      where: { nombre },
      update: { orden: i },
      create: { nombre, orden: i },
    });
  }
  for (const nombre of EMPRESAS) {
    await prismaClient.empresaExterna.upsert({
      where: { nombre },
      update: {},
      create: { nombre },
    });
  }
  logger.log(
    `Catálogos del reporte diario: ${PLANTAS.length} plantas, ${EMPRESAS.length} empresas`,
  );
}
