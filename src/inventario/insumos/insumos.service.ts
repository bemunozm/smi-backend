import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrigenMovimiento, Prisma } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { InventarioService } from '../inventario.service';
import { AjusteInsumoDto } from './dto/ajuste-insumo.dto';
import { CreateInsumoDto } from './dto/create-insumo.dto';
import { QueryInsumosDto } from './dto/query-insumos.dto';
import { UpdateInsumoDto } from './dto/update-insumo.dto';

/** Forma de `GET /api/inventario/insumos/resumen`. */
export interface ResumenInventario {
  total: number;
  /** Insumos en o por debajo de su stock mínimo (requerimientos §5.1). */
  bajoMinimo: number;
}

@Injectable()
export class InsumosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventario: InventarioService,
  ) {}

  findAll(filtros: QueryInsumosDto) {
    return this.prisma.insumo.findMany({
      where: this.buildWhere(filtros),
      orderBy: { nombre: 'asc' },
    });
  }

  async resumen(): Promise<ResumenInventario> {
    const [total, bajoMinimo] = await Promise.all([
      this.prisma.insumo.count(),
      this.prisma.insumo.count({ where: this.whereBajoStock() }),
    ]);
    return { total, bajoMinimo };
  }

  async findOne(id: string) {
    const insumo = await this.prisma.insumo.findUnique({ where: { id } });
    if (!insumo) throw new NotFoundException(`Insumo "${id}" no encontrado`);
    return insumo;
  }

  /**
   * Kardex del insumo: su historial de entradas y salidas con el saldo
   * resultante en cada punto (requerimientos §5.1). Se devuelve junto con el
   * insumo para que la pantalla no tenga que hacer dos llamadas.
   */
  async kardex(id: string) {
    const insumo = await this.findOne(id);

    const movimientos = await this.prisma.movimientoInventario.findMany({
      where: { insumoId: id },
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { id: true, codigo: true } } },
    });

    return { insumo, movimientos };
  }

  async create(dto: CreateInsumoDto, responsableId: string) {
    const { stock, ...ficha } = dto;

    try {
      // El stock inicial entra como movimiento de COMPRA, no como columna
      // suelta: así el primer renglón del kardex explica de dónde salió el
      // saldo, en vez de aparecer un stock sin origen.
      return await this.prisma.$transaction(async (tx) => {
        const insumo = await tx.insumo.create({ data: ficha });

        if (stock && stock > 0) {
          await this.inventario.registrarEntrada(
            {
              insumoId: insumo.id,
              cantidad: stock,
              origen: OrigenMovimiento.COMPRA,
              responsableId,
              observacion: 'Stock inicial al dar de alta el insumo',
            },
            tx,
          );
        }

        return tx.insumo.findUniqueOrThrow({ where: { id: insumo.id } });
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `Ya existe un insumo con el código "${dto.codigo}"`,
        );
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateInsumoDto) {
    await this.findOne(id);
    return this.prisma.insumo.update({ where: { id }, data: dto });
  }

  /** Corrección tras conteo físico. Delega en el service de stock. */
  async ajustar(id: string, dto: AjusteInsumoDto, responsableId: string) {
    await this.findOne(id);

    const movimiento = await this.inventario.ajustarPorConteo({
      insumoId: id,
      stockContado: dto.stockContado,
      responsableId,
      observacion: dto.observacion,
    });

    return {
      insumo: await this.findOne(id),
      movimiento,
    };
  }

  /**
   * Un insumo con movimientos es historia del inventario: borrarlo se llevaría
   * el kardex por delante (`onDelete: Cascade`). Se bloquea explícitamente en
   * vez de dejar que la FK decida.
   */
  async remove(id: string): Promise<void> {
    const insumo = await this.prisma.insumo.findUnique({
      where: { id },
      include: { _count: { select: { movimientos: true } } },
    });

    if (!insumo) throw new NotFoundException(`Insumo "${id}" no encontrado`);

    if (insumo._count.movimientos > 0) {
      throw new ConflictException(
        `El insumo ${insumo.codigo} tiene ${insumo._count.movimientos} movimiento(s) registrados y no se puede eliminar sin perder su kardex.`,
      );
    }

    await this.prisma.insumo.delete({ where: { id } });
  }

  private buildWhere(filtros: QueryInsumosDto): Prisma.InsumoWhereInput {
    const where: Prisma.InsumoWhereInput = {};

    if (filtros.q) {
      where.OR = [
        { codigo: { contains: filtros.q, mode: 'insensitive' } },
        { nombre: { contains: filtros.q, mode: 'insensitive' } },
      ];
    }

    if (filtros.bajoStock) {
      Object.assign(where, this.whereBajoStock());
    }

    return where;
  }

  /**
   * "Bajo stock" compara dos columnas de la misma fila (`stock <= stockMinimo`),
   * no una columna contra un valor. Se resuelve con la referencia a campo de
   * Prisma, que lo traduce a SQL — filtrar en memoria obligaría a traer la
   * tabla completa solo para contar.
   */
  private whereBajoStock(): Prisma.InsumoWhereInput {
    return { stock: { lte: this.prisma.insumo.fields.stockMinimo } };
  }
}
