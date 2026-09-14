import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EquipmentStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { CreateEquipmentDto } from './dto/create-equipment.dto';
import { QueryEquipmentDto } from './dto/query-equipment.dto';
import {
  UpdateEquipmentDto,
  UpdateEquipmentStatusDto,
} from './dto/update-equipment.dto';

/** Forma de `GET /api/equipment/resumen`, consumido por el dashboard (Benjamín). */
export interface ResumenFlota {
  total: number;
  disponibles: number;
  /** Conteo por cada valor del enum, incluidos los que están en cero. */
  porEstado: Record<EquipmentStatus, number>;
}

const ESTADOS: readonly EquipmentStatus[] = Object.values(EquipmentStatus);

/**
 * Subset de campos que necesita el mapeo de errores de Prisma para construir
 * el mensaje. `licensePlate` acepta `null` porque `UpdateEquipmentDto` lo usa
 * para limpiar la columna (ver `update-equipment.dto.ts`); `create` nunca
 * manda `null` ahí, pero el tipo debe cubrir ambos DTOs.
 */
type UniqueFieldsDto = {
  internalCode?: string;
  licensePlate?: string | null;
};

@Injectable()
export class EquipmentService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(filtros: QueryEquipmentDto) {
    const where: Prisma.EquipmentWhereInput = {};

    if (filtros.status) where.status = filtros.status;
    if (filtros.equipmentClass) where.equipmentClass = filtros.equipmentClass;
    if (filtros.controlUnit) where.controlUnit = filtros.controlUnit;
    if (filtros.homeBranchId) where.homeBranchId = filtros.homeBranchId;
    if (filtros.type) {
      where.type = { equals: filtros.type, mode: 'insensitive' };
    }
    if (filtros.q) {
      where.OR = [
        { internalCode: { contains: filtros.q, mode: 'insensitive' } },
        { licensePlate: { contains: filtros.q, mode: 'insensitive' } },
        { brand: { contains: filtros.q, mode: 'insensitive' } },
        { model: { contains: filtros.q, mode: 'insensitive' } },
      ];
    }

    return this.prisma.equipment.findMany({
      where,
      orderBy: { internalCode: 'asc' },
    });
  }

  /**
   * Agregación para el KPI "equipos disponibles" del dashboard. Existe como
   * endpoint propio para que el front no tenga que traerse la flota completa
   * solo para contar (ver `DASHBOARD-CONTRACTS.md` en smi-frontend).
   */
  async resumen(): Promise<ResumenFlota> {
    const [total, agrupado] = await Promise.all([
      this.prisma.equipment.count(),
      this.prisma.equipment.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    // `groupBy` omite los estados sin filas; el dashboard necesita las 3
    // claves siempre presentes, así que se parte de un mapa en cero.
    const porEstado = Object.fromEntries(
      ESTADOS.map((estado) => [estado, 0]),
    ) as Record<EquipmentStatus, number>;

    for (const fila of agrupado) {
      porEstado[fila.status] = fila._count._all;
    }

    return {
      total,
      disponibles: porEstado[EquipmentStatus.OPERATIONAL],
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
    const equipment = await this.prisma.equipment.findUnique({
      where: { id },
      include: {
        homeBranch: true,
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

    if (!equipment) {
      throw new NotFoundException(`Equipo "${id}" no encontrado`);
    }
    return equipment;
  }

  async create(dto: CreateEquipmentDto) {
    try {
      return await this.prisma.equipment.create({ data: dto });
    } catch (error: unknown) {
      throw this.mapPrismaError(error, dto);
    }
  }

  async update(id: string, dto: UpdateEquipmentDto) {
    await this.assertExiste(id);
    try {
      return await this.prisma.equipment.update({ where: { id }, data: dto });
    } catch (error: unknown) {
      throw this.mapPrismaError(error, dto);
    }
  }

  async updateStatus(id: string, dto: UpdateEquipmentStatusDto) {
    await this.assertExiste(id);
    return this.prisma.equipment.update({
      where: { id },
      data: { status: dto.status },
    });
  }

  /**
   * Baja física. Solo se permite si la unidad no tiene historial: un equipo con
   * registros de terreno o movimientos de inventario es parte de la
   * trazabilidad del sistema y se retira con `status = OUT_OF_SERVICE`, no
   * borrándolo.
   */
  async remove(id: string): Promise<void> {
    const equipment = await this.prisma.equipment.findUnique({
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

    if (!equipment) {
      throw new NotFoundException(`Equipo "${id}" no encontrado`);
    }

    const registros =
      equipment._count.combustibles +
      equipment._count.horometros +
      equipment._count.trabajosExtra +
      equipment._count.hallazgos +
      equipment._count.movimientos;

    if (registros > 0) {
      throw new ConflictException(
        `El equipo ${equipment.internalCode} tiene ${registros} registro(s) asociados y no se puede eliminar. ` +
          'Cámbialo a estado "Fuera de servicio" para retirarlo de la operación conservando su historial.',
      );
    }

    await this.prisma.equipment.delete({ where: { id } });
  }

  private async assertExiste(id: string): Promise<void> {
    const existe = await this.prisma.equipment.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existe) throw new NotFoundException(`Equipo "${id}" no encontrado`);
  }

  /**
   * Traduce los errores conocidos de Prisma a excepciones Nest legibles.
   * Sin esto, `create`/`update` re-lanzan el error crudo de Prisma y el
   * filtro global lo convierte en un 500 genérico ("Internal server error"),
   * incluso para errores de INPUT del usuario (código duplicado, sucursal
   * inexistente) que deberían ser 4xx.
   */
  private mapPrismaError(error: unknown, dto: UniqueFieldsDto): unknown {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return error;
    }

    if (error.code === 'P2002') {
      return this.mapUniqueConstraintError(error, dto);
    }

    // FK inválida: hoy la única FK de `Equipment` es `homeBranchId`
    // (`homeBranch`), así que el mensaje puede ser específico sin necesidad
    // de inspeccionar `error.meta` ni hacer un `findUnique` extra de Branch
    // solo para validar su existencia.
    if (error.code === 'P2003') {
      return new BadRequestException('La sucursal indicada no existe');
    }

    return error;
  }

  /**
   * `Equipment` tiene DOS columnas únicas (`internalCode`, `licensePlate`);
   * se inspecciona `meta.target` del error de Prisma para devolver un
   * `ConflictException` específico de cuál chocó, en vez de un genérico.
   */
  private mapUniqueConstraintError(
    error: Prisma.PrismaClientKnownRequestError,
    dto: UniqueFieldsDto,
  ): ConflictException {
    const target = error.meta?.target;
    const targetStr = Array.isArray(target)
      ? target.join(',')
      : typeof target === 'string'
        ? target
        : '';

    if (targetStr.includes('internal_code')) {
      return new ConflictException(
        `Ya existe un equipo con el código "${dto.internalCode}"`,
      );
    }
    if (targetStr.includes('license_plate')) {
      return new ConflictException(
        `Ya existe un equipo con la patente "${dto.licensePlate}"`,
      );
    }
    return new ConflictException(
      'Ya existe un equipo con esos datos únicos (código o patente)',
    );
  }
}
