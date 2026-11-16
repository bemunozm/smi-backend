import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  CreateEmpresaExternaDto,
  UpdateEmpresaExternaDto,
} from './dto/empresa-externa.dto';

/** Empresa externa en la vista del administrador: con cuántos reportes la usan. */
export interface EmpresaExternaAdmin {
  id: string;
  nombre: string;
  activa: boolean;
  /** Reportes diarios que la marcaron: con alguno no se puede borrar del todo. */
  reportes: number;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CatalogosReporteService {
  constructor(private prisma: PrismaService) {}

  plantas() {
    return this.prisma.planta.findMany({
      where: { activa: true },
      orderBy: { orden: 'asc' },
    });
  }

  /** Las que ve el supervisor al cargar el reporte: solo las activas. */
  empresasExternas() {
    return this.prisma.empresaExterna.findMany({
      where: { activa: true },
      orderBy: { nombre: 'asc' },
    });
  }

  /** Todas (también las desactivadas), para el CRUD del administrador. */
  async empresasExternasAdmin(): Promise<EmpresaExternaAdmin[]> {
    const filas = await this.prisma.empresaExterna.findMany({
      orderBy: [{ activa: 'desc' }, { nombre: 'asc' }],
      include: { _count: { select: { reportes: true } } },
    });
    return filas.map(({ _count, ...e }) => ({
      ...e,
      reportes: _count.reportes,
    }));
  }

  /**
   * Alta. Si ya existe una con el mismo nombre (sin distinguir mayúsculas):
   * activa → 409; desactivada → se reactiva (conserva sus reportes).
   */
  async crearEmpresaExterna(dto: CreateEmpresaExternaDto) {
    const existente = await this.buscarPorNombre(dto.nombre);
    if (existente?.activa) {
      throw new ConflictException(`Ya existe la empresa ${existente.nombre}.`);
    }
    if (existente) {
      return this.prisma.empresaExterna.update({
        where: { id: existente.id },
        data: { activa: true, nombre: dto.nombre },
      });
    }
    return this.prisma.empresaExterna.create({ data: { nombre: dto.nombre } });
  }

  async actualizarEmpresaExterna(id: string, dto: UpdateEmpresaExternaDto) {
    await this.assertEmpresa(id);
    if (dto.nombre !== undefined) {
      const otra = await this.buscarPorNombre(dto.nombre);
      if (otra && otra.id !== id) {
        throw new ConflictException(`Ya existe la empresa ${otra.nombre}.`);
      }
    }
    return this.prisma.empresaExterna.update({
      where: { id },
      data: {
        ...(dto.nombre !== undefined ? { nombre: dto.nombre } : {}),
        ...(dto.activa !== undefined ? { activa: dto.activa } : {}),
      },
    });
  }

  /**
   * Sin reportes se borra. Con reportes NO se puede borrar (los reportes
   * anteriores la nombran): se desactiva, deja de salir en el reporte del
   * supervisor y se puede reactivar después.
   */
  async eliminarEmpresaExterna(
    id: string,
  ): Promise<{ eliminada: boolean; desactivada: boolean }> {
    await this.assertEmpresa(id);
    const usos = await this.prisma.reporteEmpresa.count({
      where: { empresaId: id },
    });
    if (usos > 0) {
      await this.prisma.empresaExterna.update({
        where: { id },
        data: { activa: false },
      });
      return { eliminada: false, desactivada: true };
    }
    await this.prisma.empresaExterna.delete({ where: { id } });
    return { eliminada: true, desactivada: false };
  }

  private buscarPorNombre(nombre: string) {
    return this.prisma.empresaExterna.findFirst({
      where: { nombre: { equals: nombre, mode: 'insensitive' } },
    });
  }

  private async assertEmpresa(id: string): Promise<void> {
    const existe = await this.prisma.empresaExterna.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existe) throw new NotFoundException('La empresa no existe.');
  }
}
