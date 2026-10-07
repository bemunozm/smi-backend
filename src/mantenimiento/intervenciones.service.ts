import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MovementReason } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import { createOrReturn } from '../common/idempotency/create-or-return';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  StockService,
  type PendingStockEvents,
} from '../inventory/stock.service';
import { StorageService } from '../storage/storage.service';
import type { CreateIntervencionDto } from './dto/create-intervencion.dto';
import type { IntervencionResponseDto } from './dto/intervencion-response.dto';

const INTERVENCION_SELECT = {
  id: true,
  ordenId: true,
  tipo: true,
  detalle: true,
  horasHombre: true,
  horometro: true,
  fotoKey: true,
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly storage: StorageService,
  ) {}

  async findAllByOrden(ordenId: string): Promise<IntervencionResponseDto[]> {
    await this.findOrdenOrThrow(ordenId);

    const intervenciones = await this.prisma.intervencion.findMany({
      where: { ordenId },
      select: INTERVENCION_SELECT,
      orderBy: { fecha: 'desc' },
    });

    return Promise.all(
      intervenciones.map((intervencion) => this.toResponseDto(intervencion)),
    );
  }

  /**
   * Crea la `Intervencion`, sus filas `IntervencionInsumo` Y el descuento de
   * stock de cada insumo en UNA sola transacción (`StockService.issue` con el
   * mismo `tx`) — o queda todo o no queda nada. Si algún insumo no alcanza en
   * la bodega indicada, el 409 de `issue` revierte también la intervención.
   */
  async create(
    ordenId: string,
    dto: CreateIntervencionDto,
    userId: string,
  ): Promise<IntervencionResponseDto> {
    const orden = await this.findOrdenOrThrow(ordenId);

    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe una intervención con ese id de otro usuario',
      findExisting: async (id) => {
        const existing = await this.prisma.intervencion.findUnique({
          where: { id },
          select: { ...INTERVENCION_SELECT, createdById: true },
        });
        if (!existing) return null;
        const { createdById, ...intervencion } = existing;
        return {
          ownerId: createdById,
          // El reintento devuelve la fila ya creada SIN repetir el descuento:
          // los movimientos de stock salieron con la transacción original.
          result: () => this.toResponseDto(intervencion),
        };
      },
      create: () => this.createFresh(orden, dto, userId),
    });
  }

  private async createFresh(
    orden: { id: string; equipoId: string },
    dto: CreateIntervencionDto,
    userId: string,
  ): Promise<IntervencionResponseDto> {
    const insumos = dto.insumos ?? [];
    const branchId = dto.branchId;
    if (insumos.length > 0 && !branchId) {
      throw new BadRequestException(
        'Indica la bodega de la que salen los insumos.',
      );
    }

    // `equipoId` de la OT es texto libre (código interno o id de Flota): si se
    // resuelve, el movimiento queda imputado a la unidad; si no, el descuento
    // sale igual — la trazabilidad por `reference` (la OT) no se pierde.
    const equipmentId =
      insumos.length > 0 ? await this.resolveEquipmentId(orden.equipoId) : null;

    // El claim va ANTES de la transacción y fuera del try (patrón
    // `hallazgos.service.createFresh`): si falla, no hay nada que revertir.
    const finalKey = dto.fotoKey
      ? await this.storage.claimTmp(dto.fotoKey, userId, 'intervencion-photo')
      : undefined;

    const events: PendingStockEvents = [];
    let intervencion: SelectedIntervencion;
    try {
      intervencion = await this.prisma.$transaction(async (tx) => {
        const created = await tx.intervencion.create({
          data: {
            ...(dto.id ? { id: dto.id } : {}),
            createdById: userId,
            realizadaPorId: userId,
            ordenId: orden.id,
            tipo: dto.tipo,
            detalle: dto.detalle,
            horasHombre: dto.horasHombre,
            horometro: dto.horometro,
            fotoKey: finalKey ?? null,
            insumos:
              insumos.length > 0
                ? {
                    create: insumos.map((insumo) => ({
                      insumoId: insumo.insumoId,
                      cantidad: insumo.cantidad,
                    })),
                  }
                : undefined,
          },
          select: INTERVENCION_SELECT,
        });

        for (const insumo of insumos) {
          await this.stock.issue(
            {
              itemId: insumo.insumoId,
              // `branchId` está garantizado arriba cuando hay insumos.
              branchId: branchId as string,
              quantity: insumo.cantidad,
              reason: MovementReason.INTERVENTION,
              performedById: userId,
              equipmentId,
              reference: orden.id,
            },
            { tx, events },
          );
        }

        return created;
      });
    } catch (error: unknown) {
      // La foto ya está reclamada en el bucket: si la transacción se revierte
      // (p. ej. 409 por stock insuficiente), quedaría huérfana — se suelta.
      if (finalKey) {
        await this.storage.discard(finalKey);
      }
      throw error;
    }

    // Los avisos de stock bajo se emiten SOLO tras confirmar la transacción.
    this.stock.emitPending(events);

    this.logger.log(
      `Intervención registrada en orden ${orden.id}: ${intervencion.id}`,
    );

    return this.toResponseDto(intervencion);
  }

  /** Resuelve la unidad de Flota desde el `equipoId` libre de la OT. */
  private async resolveEquipmentId(equipoId: string): Promise<string | null> {
    const byId = await this.prisma.equipment.findUnique({
      where: { id: equipoId },
      select: { id: true },
    });
    if (byId) return byId.id;

    const byCode = await this.prisma.equipment.findUnique({
      where: { internalCode: equipoId },
      select: { id: true },
    });
    return byCode?.id ?? null;
  }

  private async findOrdenOrThrow(
    ordenId: string,
  ): Promise<{ id: string; equipoId: string }> {
    const orden = await this.prisma.ordenTrabajo.findUnique({
      where: { id: ordenId },
      select: { id: true, equipoId: true },
    });

    if (!orden) {
      throw new NotFoundException(
        `Orden de trabajo con id "${ordenId}" no encontrada`,
      );
    }

    return orden;
  }

  /**
   * Nunca devuelve `fotoKey` — solo `fotoUrl` firmada cuando hay foto (mismo
   * criterio que `HallazgosService.shape`).
   */
  private async toResponseDto(
    intervencion: SelectedIntervencion,
  ): Promise<IntervencionResponseDto> {
    return {
      id: intervencion.id,
      ordenId: intervencion.ordenId,
      tipo: intervencion.tipo,
      detalle: intervencion.detalle,
      horasHombre: intervencion.horasHombre,
      horometro: intervencion.horometro,
      fotoUrl: intervencion.fotoKey
        ? await this.storage.sign(intervencion.fotoKey)
        : null,
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
