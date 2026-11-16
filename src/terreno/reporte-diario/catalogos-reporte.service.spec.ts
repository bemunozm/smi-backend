import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../common/prisma/prisma.service';
import { CatalogosReporteService } from './catalogos-reporte.service';

describe('CatalogosReporteService', () => {
  let service: CatalogosReporteService;
  const prisma = {
    planta: { findMany: jest.fn() },
    empresaExterna: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    reporteEmpresa: { count: jest.fn() },
  };

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        CatalogosReporteService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(CatalogosReporteService);
    jest.resetAllMocks();
    prisma.planta.findMany.mockResolvedValue([]);
    prisma.empresaExterna.findMany.mockResolvedValue([]);
    prisma.empresaExterna.findUnique.mockResolvedValue({ id: 'e1' });
    prisma.empresaExterna.findFirst.mockResolvedValue(null);
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

  describe('CRUD del administrador', () => {
    it('lista todas con cuántos reportes las usan', async () => {
      prisma.empresaExterna.findMany.mockResolvedValue([
        { id: 'e1', nombre: 'Hyd', activa: false, _count: { reportes: 3 } },
      ]);
      await expect(service.empresasExternasAdmin()).resolves.toEqual([
        { id: 'e1', nombre: 'Hyd', activa: false, reportes: 3 },
      ]);
    });

    it('crea una empresa nueva', async () => {
      prisma.empresaExterna.create.mockResolvedValue({ id: 'e9' });
      await service.crearEmpresaExterna({ nombre: 'Spence' });
      expect(prisma.empresaExterna.create).toHaveBeenCalledWith({
        data: { nombre: 'Spence' },
      });
    });

    it('un nombre repetido (sin importar mayúsculas) de una activa da 409', async () => {
      prisma.empresaExterna.findFirst.mockResolvedValue({
        id: 'e1',
        nombre: 'Hyd',
        activa: true,
      });
      await expect(
        service.crearEmpresaExterna({ nombre: 'HYD' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.empresaExterna.create).not.toHaveBeenCalled();
    });

    it('volver a agregar una desactivada la reactiva', async () => {
      prisma.empresaExterna.findFirst.mockResolvedValue({
        id: 'e1',
        nombre: 'Hyd',
        activa: false,
      });
      await service.crearEmpresaExterna({ nombre: 'Hyd' });
      expect(prisma.empresaExterna.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { activa: true, nombre: 'Hyd' },
      });
      expect(prisma.empresaExterna.create).not.toHaveBeenCalled();
    });

    it('renombrar a un nombre de otra empresa da 409', async () => {
      prisma.empresaExterna.findFirst.mockResolvedValue({
        id: 'e2',
        nombre: 'Sijam',
        activa: true,
      });
      await expect(
        service.actualizarEmpresaExterna('e1', { nombre: 'sijam' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('sin reportes se borra', async () => {
      prisma.reporteEmpresa.count.mockResolvedValue(0);
      await expect(service.eliminarEmpresaExterna('e1')).resolves.toEqual({
        eliminada: true,
        desactivada: false,
      });
      expect(prisma.empresaExterna.delete).toHaveBeenCalledWith({
        where: { id: 'e1' },
      });
    });

    it('con reportes no se borra: se desactiva', async () => {
      prisma.reporteEmpresa.count.mockResolvedValue(4);
      await expect(service.eliminarEmpresaExterna('e1')).resolves.toEqual({
        eliminada: false,
        desactivada: true,
      });
      expect(prisma.empresaExterna.delete).not.toHaveBeenCalled();
      expect(prisma.empresaExterna.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { activa: false },
      });
    });

    it('una empresa que no existe da 404', async () => {
      prisma.empresaExterna.findUnique.mockResolvedValue(null);
      await expect(
        service.eliminarEmpresaExterna('nada'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
