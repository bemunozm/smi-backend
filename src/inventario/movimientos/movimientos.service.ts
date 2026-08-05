import { Injectable } from '@nestjs/common';
import { MovimientoInventario, Prisma, TipoMovimiento } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { InventarioService } from '../inventario.service';
import { CreateMovimientoDto } from './dto/create-movimiento.dto';
import { QueryMovimientosDto } from './dto/query-movimientos.dto';

const LIMITE_POR_DEFECTO = 100;

@Injectable()
export class MovimientosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventario: InventarioService,
  ) {}

  findAll(filtros: QueryMovimientosDto) {
    const where: Prisma.MovimientoInventarioWhereInput = {};

    if (filtros.insumoId) where.insumoId = filtros.insumoId;
    if (filtros.equipoId) where.equipoId = filtros.equipoId;
    if (filtros.tipo) where.tipo = filtros.tipo;
    if (filtros.origen) where.origen = filtros.origen;

    if (filtros.desde || filtros.hasta) {
      where.fecha = {
        ...(filtros.desde ? { gte: new Date(filtros.desde) } : {}),
        ...(filtros.hasta ? { lte: new Date(filtros.hasta) } : {}),
      };
    }

    return this.prisma.movimientoInventario.findMany({
      where,
      orderBy: { fecha: 'desc' },
      take: filtros.limit ?? LIMITE_POR_DEFECTO,
      include: {
        insumo: {
          select: { id: true, codigo: true, nombre: true, unidad: true },
        },
        equipo: { select: { id: true, codigo: true } },
      },
    });
  }

  /**
   * Movimiento manual. Enruta al método correspondiente de `InventarioService`
   * según el tipo — la lógica de stock vive allá, acá solo se decide el signo.
   */
  create(
    dto: CreateMovimientoDto,
    responsableId: string,
  ): Promise<MovimientoInventario> {
    const input = {
      insumoId: dto.insumoId,
      cantidad: dto.cantidad,
      origen: dto.origen,
      responsableId,
      equipoId: dto.equipoId ?? null,
      referenciaId: dto.referenciaId ?? null,
      observacion: dto.observacion ?? null,
    };

    return dto.tipo === TipoMovimiento.ENTRADA
      ? this.inventario.registrarEntrada(input)
      : this.inventario.registrarSalida(input);
  }
}
