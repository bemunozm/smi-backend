import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EstadoEquipo, Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { CreateEquipoDto } from './dto/create-equipo.dto';
import { QueryEquiposDto } from './dto/query-equipos.dto';
import {
  UpdateEquipoDto,
  UpdateEstadoEquipoDto,
} from './dto/update-equipo.dto';

/** Forma de `GET /api/equipos/resumen`, consumido por el dashboard (Benjamín). */
export interface ResumenFlota {
  total: number;
  disponibles: number;
  /** Conteo por cada valor del enum, incluidos los que están en cero. */
  porEstado: Record<EstadoEquipo, number>;
}

const ESTADOS: readonly EstadoEquipo[] = Object.values(EstadoEquipo);

@Injectable()
export class EquiposService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(filtros: QueryEquiposDto) {
    const where: Prisma.EquipoWhereInput = {};

    if (filtros.estado) where.estado = filtros.estado;
    if (filtros.tipo) {
      where.tipo = { equals: filtros.tipo, mode: 'insensitive' };
    }
    if (filtros.q) {
      where.OR = [
        { codigo: { contains: filtros.q, mode: 'insensitive' } },
        { marca: { contains: filtros.q, mode: 'insensitive' } },
        { modelo: { contains: filtros.q, mode: 'insensitive' } },
      ];
    }

    return this.prisma.equipo.findMany({ where, orderBy: { codigo: 'asc' } });
  }

  /**
   * Agregación para el KPI "equipos disponibles" del dashboard. Existe como
   * endpoint propio para que el front no tenga que traerse la flota completa
   * solo para contar (ver `DASHBOARD-CONTRACTS.md` en smi-frontend).
   */
  async resumen(): Promise<ResumenFlota> {
    const [total, agrupado] = await Promise.all([
      this.prisma.equipo.count(),
      this.prisma.equipo.groupBy({ by: ['estado'], _count: { _all: true } }),
    ]);

    // `groupBy` omite los estados sin filas; el dashboard necesita las 4 claves
    // siempre presentes, así que se parte de un mapa en cero.
    const porEstado = Object.fromEntries(
      ESTADOS.map((estado) => [estado, 0]),
    ) as Record<EstadoEquipo, number>;

    for (const fila of agrupado) {
      porEstado[fila.estado] = fila._count._all;
    }

    return {
      total,
      disponibles: porEstado[EstadoEquipo.DISPONIBLE],
      porEstado,
    };
  }

  /**
   * Ficha del equipo. Incluye el conteo de registros asociados de los otros
   * dominios (solo lectura) para que la ficha muestre actividad real sin tener
   * que pedirle un endpoint a cada dueño. La línea de tiempo consolidada
   * (requerimientos §5.5) es de Benjamín — esto no la reemplaza.
   */
  async findOne(id: string) {
    const equipo = await this.prisma.equipo.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            combustibles: true,
            horometros: true,
            trabajosExtra: true,
            hallazgos: true,
            movimientos: true,
          },
        },
        movimientos: {
          orderBy: { fecha: 'desc' },
          take: 10,
          include: {
            insumo: { select: { codigo: true, nombre: true, unidad: true } },
          },
        },
      },
    });

    if (!equipo) throw new NotFoundException(`Equipo "${id}" no encontrado`);
    return equipo;
  }

  async create(dto: CreateEquipoDto) {
    try {
      return await this.prisma.equipo.create({ data: dto });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `Ya existe un equipo con el código "${dto.codigo}"`,
        );
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateEquipoDto) {
    await this.assertExiste(id);
    return this.prisma.equipo.update({ where: { id }, data: dto });
  }

  async updateEstado(id: string, dto: UpdateEstadoEquipoDto) {
    await this.assertExiste(id);
    return this.prisma.equipo.update({
      where: { id },
      data: { estado: dto.estado },
    });
  }

  /**
   * Baja física. Solo se permite si la unidad no tiene historial: un equipo con
   * registros de terreno o movimientos de inventario es parte de la
   * trazabilidad del sistema y se retira con `estado = DE_BAJA`, no borrándolo.
   */
  async remove(id: string): Promise<void> {
    const equipo = await this.prisma.equipo.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            combustibles: true,
            horometros: true,
            trabajosExtra: true,
            hallazgos: true,
            movimientos: true,
          },
        },
      },
    });

    if (!equipo) throw new NotFoundException(`Equipo "${id}" no encontrado`);

    const registros =
      equipo._count.combustibles +
      equipo._count.horometros +
      equipo._count.trabajosExtra +
      equipo._count.hallazgos +
      equipo._count.movimientos;

    if (registros > 0) {
      throw new ConflictException(
        `El equipo ${equipo.codigo} tiene ${registros} registro(s) asociados y no se puede eliminar. ` +
          'Cámbialo a estado "De baja" para retirarlo de la operación conservando su historial.',
      );
    }

    await this.prisma.equipo.delete({ where: { id } });
  }

  private async assertExiste(id: string): Promise<void> {
    const existe = await this.prisma.equipo.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existe) throw new NotFoundException(`Equipo "${id}" no encontrado`);
  }
}
