import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import type { CreateIntervencionDto } from './dto/create-intervencion.dto';
import type { IntervencionResponseDto } from './dto/intervencion-response.dto';

const INTERVENCION_SELECT = {
  id: true,
  ordenId: true,
  tipo: true,
  detalle: true,
  horasHombre: true,
  horometro: true,
  soloLectura: true,
  fecha: true,
  insumos: {
    select: { id: true, insumoId: true, cantidad: true },
  },
} satisfies Prisma.IntervencionSelect;

type SelectedIntervencion = Prisma.IntervencionGetPayload<{
  select: typeof INTERVENCION_SELECT;
}>;

@Injectable()
export class IntervencionesService {
  private readonly logger = new Logger(IntervencionesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAllByOrden(ordenId: string): Promise<IntervencionResponseDto[]> {
    await this.assertOrdenExists(ordenId);

    const intervenciones = await this.prisma.intervencion.findMany({
      where: { ordenId },
      select: INTERVENCION_SELECT,
      orderBy: { fecha: 'desc' },
    });

    return intervenciones.map((intervencion) =>
      this.toResponseDto(intervencion),
    );
  }

  /**
   * Crea la `Intervencion` y sus filas `IntervencionInsumo` (si vienen) en
   * una única transacción — o quedan ambas o ninguna.
   */
  async create(
    ordenId: string,
    dto: CreateIntervencionDto,
  ): Promise<IntervencionResponseDto> {
    await this.assertOrdenExists(ordenId);

    const intervencion = await this.prisma.$transaction(async (tx) => {
      const created = await tx.intervencion.create({
        data: {
          ordenId,
          tipo: dto.tipo,
          detalle: dto.detalle,
          horasHombre: dto.horasHombre,
          horometro: dto.horometro,
          insumos: dto.insumos
            ? {
                create: dto.insumos.map((insumo) => ({
                  insumoId: insumo.insumoId,
                  cantidad: insumo.cantidad,
                })),
              }
            : undefined,
        },
        select: INTERVENCION_SELECT,
      });

      // TODO(cruce Inventario/Amin): la tabla `Insumo` (con su columna
      // `stock`) es de otro dominio y todavía no existe en este schema, así
      // que a propósito NO se decrementa ningún stock acá. Cuando el módulo
      // de Inventario exista, reemplazar `descontarStock` por una llamada
      // real a `InventarioService.registrarSalida(insumoId, cantidad)` —
      // idealmente pasándole este mismo `tx` para mantener la atomicidad de
      // "crear intervención + descontar stock" en una sola transacción.
      if (dto.insumos && dto.insumos.length > 0) {
        this.descontarStock(dto.insumos);
      }

      return created;
    });

    this.logger.log(
      `Intervención registrada en orden ${ordenId}: ${intervencion.id}`,
    );

    return this.toResponseDto(intervencion);
  }

  /**
   * Seam intencional para el futuro cruce con el dominio Inventario/Amin.
   * Hoy es un no-op: NO descuenta `Insumo.stock` (esa tabla no existe aún en
   * este schema). Ver TODO en `create()`.
   */
  private descontarStock(
    insumos: ReadonlyArray<{ insumoId: string; cantidad: number }>,
  ): void {
    this.logger.debug(
      `TODO cruce Inventario/Amin: pendiente descontar stock de ${insumos.length} insumo(s) (${insumos.map((i) => `${i.insumoId}x${i.cantidad}`).join(', ')})`,
    );
  }

  private async assertOrdenExists(ordenId: string): Promise<void> {
    const orden = await this.prisma.ordenTrabajo.findUnique({
      where: { id: ordenId },
      select: { id: true },
    });

    if (!orden) {
      throw new NotFoundException(
        `Orden de trabajo con id "${ordenId}" no encontrada`,
      );
    }
  }

  private toResponseDto(
    intervencion: SelectedIntervencion,
  ): IntervencionResponseDto {
    return {
      id: intervencion.id,
      ordenId: intervencion.ordenId,
      tipo: intervencion.tipo,
      detalle: intervencion.detalle,
      horasHombre: intervencion.horasHombre,
      horometro: intervencion.horometro,
      soloLectura: intervencion.soloLectura,
      insumos: intervencion.insumos.map((insumo) => ({
        id: insumo.id,
        insumoId: insumo.insumoId,
        cantidad: insumo.cantidad,
      })),
      fecha: intervencion.fecha.toISOString(),
    };
  }
}
