import { Test } from '@nestjs/testing';

import { PrismaService } from '../../common/prisma/prisma.service';
import { CatalogosReporteService } from './catalogos-reporte.service';

describe('CatalogosReporteService', () => {
  let service: CatalogosReporteService;
  const prisma = {
    planta: { findMany: jest.fn().mockResolvedValue([]) },
    empresaExterna: { findMany: jest.fn().mockResolvedValue([]) },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        CatalogosReporteService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(CatalogosReporteService);
    jest.clearAllMocks();
  });

  it('lista solo plantas activas, ordenadas por orden', async () => {
    await service.plantas();
    expect(prisma.planta.findMany).toHaveBeenCalledWith({
      where: { activa: true },
      orderBy: { orden: 'asc' },
    });
  });

  it('lista solo empresas activas, ordenadas por nombre', async () => {
    await service.empresasExternas();
    expect(prisma.empresaExterna.findMany).toHaveBeenCalledWith({
      where: { activa: true },
      orderBy: { nombre: 'asc' },
    });
  });
});
