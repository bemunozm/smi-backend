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
import { resolveAsignadosMap } from './common/asignado.util';
import type {
  CreateIntervencionDto,
  IntervencionBaseDto,
} from './dto/create-intervencion.dto';
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
  realizadaPorId: true,
  insumos: {
    select: { id: true, insumoId: true, cantidad: true },
  },
} satisfies Prisma.IntervencionSelect;

/** La fila escrita, antes de darle forma de respuesta (`shapeOne`). */
export type SelectedIntervencion = Prisma.IntervencionGetPayload<{
  select: typeof INTERVENCION_SELECT;
}>;

/**
 * Una intervención lista para escribirse dentro de una transacción: lo que se
 * valida y resuelve ANTES de abrirla (bodega, unidad de Flota, foto ya
 * reclamada). La deja `preparar`, la escribe `crearEnTransaccion` y, si la
 * transacción no confirma, `descartar` suelta la foto.
 */
export interface IntervencionPreparada {
  orden: { id: string; equipoId: string };
  dto: IntervencionBaseDto & { id?: string };
  userId: string;
  /** Unidad de Flota a la que se imputan los insumos (null si no resuelve). */
  equipmentId: string | null;
  /** Key definitiva de la foto, ya reclamada del `tmp/`. */
  fotoKey: string | undefined;
}

/** Una intervención ya existente con el id del cliente (reintento offline). */
export interface IntervencionExistente {
  ownerId: string | null;
  ordenId: string;
  /** La respuesta de la fila (URL de la foto firmada al momento). */
  result: () => Promise<IntervencionResponseDto>;
}

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

    const nombres = await resolveAsignadosMap(
      this.prisma,
      intervenciones.map((intervencion) => intervencion.realizadaPorId),
    );
    return Promise.all(
      intervenciones.map((intervencion) =>
        this.toResponseDto(intervencion, nombres),
      ),
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
      findExisting: (id) => this.findExisting(id),
      create: () => this.createFresh(orden, dto, userId),
    });
  }

  /**
   * La intervención con ese id del cliente, si ya existe. El reintento
   * devuelve la fila ya creada SIN repetir el descuento: los movimientos de
   * stock salieron con la transacción original.
   */
  async findExisting(id: string): Promise<IntervencionExistente | null> {
    const existing = await this.prisma.intervencion.findUnique({
      where: { id },
      select: { ...INTERVENCION_SELECT, createdById: true },
    });
    if (!existing) return null;
    const { createdById, ...intervencion } = existing;
    return {
      ownerId: createdById,
      ordenId: intervencion.ordenId,
      result: () => this.shapeOne(intervencion),
    };
  }

  private async createFresh(
    orden: { id: string; equipoId: string },
    dto: CreateIntervencionDto,
    userId: string,
  ): Promise<IntervencionResponseDto> {
    const preparada = await this.preparar(orden, dto, userId);

    const events: PendingStockEvents = [];
    let intervencion: SelectedIntervencion;
    try {
      intervencion = await this.prisma.$transaction((tx) =>
        this.crearEnTransaccion(tx, preparada, events),
      );
    } catch (error: unknown) {
      await this.descartar(preparada);
      throw error;
    }

    // Los avisos de stock bajo se emiten SOLO tras confirmar la transacción.
    this.stock.emitPending(events);

    this.logger.log(
      `Intervención registrada en orden ${orden.id}: ${intervencion.id}`,
    );

    return this.shapeOne(intervencion);
  }

  /**
   * Todo lo que va ANTES de la transacción: exige la bodega si hay insumos,
   * resuelve la unidad de Flota y reclama la foto. El claim queda fuera del
   * try del caller (patrón `hallazgos.service.createFresh`): si falla, no hay
   * nada que revertir. Lo usan el alta suelta y `OrdenesService.finalizar`.
   */
  async preparar(
    orden: { id: string; equipoId: string },
    dto: IntervencionBaseDto & { id?: string },
    userId: string,
  ): Promise<IntervencionPreparada> {
    const insumos = dto.insumos ?? [];
    if (insumos.length > 0 && !dto.branchId) {
      throw new BadRequestException(
        'Indica la bodega de la que salen los insumos.',
      );
    }

    // `equipoId` de la OT es texto libre (código interno o id de Flota): si se
    // resuelve, el movimiento queda imputado a la unidad; si no, el descuento
    // sale igual — la trazabilidad por `reference` (la OT) no se pierde.
    const equipmentId =
      insumos.length > 0 ? await this.resolveEquipmentId(orden.equipoId) : null;

    const fotoKey = dto.fotoKey
      ? await this.storage.claimTmp(dto.fotoKey, userId, 'intervencion-photo')
      : undefined;

    return { orden, dto, userId, equipmentId, fotoKey };
  }

  /**
   * Crea la `Intervencion`, sus filas `IntervencionInsumo` y el descuento de
   * stock de cada insumo con el `tx` del caller (`StockService.issue` con el
   * mismo `tx`) — o queda todo o no queda nada: si algún insumo no alcanza,
   * el 409 de `issue` revierte la transacción entera. Los avisos de stock
   * quedan en `events`: el caller los emite solo tras confirmar.
   */
  async crearEnTransaccion(
    tx: Prisma.TransactionClient,
    preparada: IntervencionPreparada,
    events: PendingStockEvents,
  ): Promise<SelectedIntervencion> {
    const { orden, dto, userId, equipmentId, fotoKey } = preparada;
    const insumos = dto.insumos ?? [];

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
        fotoKey: fotoKey ?? null,
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
          // `branchId` está garantizado por `preparar` cuando hay insumos.
          branchId: dto.branchId as string,
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
  }

  /**
   * La transacción no confirmó (p. ej. 409 por stock insuficiente): la foto
   * ya reclamada en el bucket quedaría huérfana — se suelta.
   */
  async descartar(preparada: IntervencionPreparada): Promise<void> {
    if (preparada.fotoKey) {
      await this.storage.discard(preparada.fotoKey);
    }
  }

  /** `toResponseDto` para UNA fila: resuelve su `realizadaPor` por su cuenta. */
  async shapeOne(
    intervencion: SelectedIntervencion,
  ): Promise<IntervencionResponseDto> {
    const nombres = await resolveAsignadosMap(this.prisma, [
      intervencion.realizadaPorId,
    ]);
    return this.toResponseDto(intervencion, nombres);
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
    nombres: Map<string, { nombre: string }>,
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
      realizadaPor:
        (intervencion.realizadaPorId &&
          nombres.get(intervencion.realizadaPorId)?.nombre) ||
        null,
      insumos: intervencion.insumos.map((insumo) => ({
        id: insumo.id,
        insumoId: insumo.insumoId,
        cantidad: insumo.cantidad,
      })),
      fecha: intervencion.fecha.toISOString(),
    };
  }
}
