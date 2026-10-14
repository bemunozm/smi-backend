import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class CatalogosReporteService {
  constructor(private prisma: PrismaService) {}

  plantas() {
    return this.prisma.planta.findMany({
      where: { activa: true },
      orderBy: { orden: 'asc' },
    });
  }

  empresasExternas() {
    return this.prisma.empresaExterna.findMany({
      where: { activa: true },
      orderBy: { nombre: 'asc' },
    });
  }
}
