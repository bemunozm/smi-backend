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
import {
  MAX_FOTOS_CIERRE,
  type CreateIntervencionDto,
  type IntervencionBaseDto,
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
  fotos: { select: { key: true }, orderBy: { orden: 'asc' } },
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
 * reclamadas). La deja `preparar`, la escribe `crearEnTransaccion` y, si la
 * transacción no confirma, `descartar` suelta las fotos.
 */
export interface IntervencionPreparada {
  orden: { id: string; equipoId: string };
  dto: IntervencionBaseDto & { id?: string };
  userId: string;
  /** Unidad de Flota a la que se imputan los insumos (null si no resuelve). */
  equipmentId: string | null;
  /** Keys definitivas de las fotos, ya reclamadas del `tmp/`, en orden. */
  fotoKeys: string[];
}

/** Una intervención ya existente con el id del cliente (reintento offline). */
export interface IntervencionExistente {
  ownerId: string | null;
  ordenId: string;
  /** La respuesta de la fila (URLs de las fotos firmadas al momento). */
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
   * resuelve la unidad de Flota y reclama las fotos. El claim queda fuera del
   * try del caller (patrón `hallazgos.service.createFresh`): si falla, suelta
   * aquí mismo las que alcanzó a reclamar y no queda nada que revertir. Lo
   * usan el alta suelta y `OrdenesService.finalizar`.
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

    // `fotoKey` (escrituras encoladas con una sola foto) y `fotoKeys` son UNA
    // lista: la vieja primero, sin repetir. El tope vale para la suma.
    const tmpKeys = [
      ...new Set([
        ...(dto.fotoKey ? [dto.fotoKey] : []),
        ...(dto.fotoKeys ?? []),
      ]),
    ];
    if (tmpKeys.length > MAX_FOTOS_CIERRE) {
      throw new BadRequestException(
        `Puedes adjuntar hasta ${MAX_FOTOS_CIERRE} fotos al cierre.`,
      );
    }

    // `equipoId` de la OT es texto libre (código interno o id de Flota): si se
    // resuelve, el movimiento queda imputado a la unidad; si no, el descuento
    // sale igual — la trazabilidad por `reference` (la OT) no se pierde.
    const equipmentId =
      insumos.length > 0 ? await this.resolveEquipmentId(orden.equipoId) : null;

    const fotoKeys = await this.reclamarFotos(tmpKeys, userId);

    return { orden, dto, userId, equipmentId, fotoKeys };
  }

  /**
   * Reclama las fotos de a una, en orden. Si una falla (key ajena, ya
   * reclamada, inexistente), suelta las anteriores antes de propagar el
   * error: ninguna queda huérfana en el bucket.
   */
  private async reclamarFotos(
    tmpKeys: string[],
    userId: string,
  ): Promise<string[]> {
    const reclamadas: string[] = [];
    try {
      for (const tmpKey of tmpKeys) {
        reclamadas.push(
          await this.storage.claimTmp(tmpKey, userId, 'intervencion-photo'),
        );
      }
    } catch (error: unknown) {
      await this.soltarFotos(reclamadas);
      throw error;
    }
    return reclamadas;
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
    const { orden, dto, userId, equipmentId, fotoKeys } = preparada;
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
        // La primera también en la columna vieja: un backend anterior la
        // sigue mostrando si hubiera que volver atrás.
        fotoKey: fotoKeys[0] ?? null,
        fotos:
          fotoKeys.length > 0
            ? { create: fotoKeys.map((key, orden) => ({ key, orden })) }
            : undefined,
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
   * La transacción no confirmó (p. ej. 409 por stock insuficiente): las
   * fotos ya reclamadas en el bucket quedarían huérfanas — se sueltan todas.
   */
  async descartar(preparada: IntervencionPreparada): Promise<void> {
    await this.soltarFotos(preparada.fotoKeys);
  }

  /** Suelta cada foto (`discard` nunca lanza: una no impide las demás). */
  private async soltarFotos(keys: string[]): Promise<void> {
    for (const key of keys) await this.storage.discard(key);
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
   * Nunca devuelve keys — solo URLs firmadas (mismo criterio que
   * `HallazgosService.shape`). Las fotos salen de `fotos`; una fila sin filas
   * de fotos pero con `fotoKey` (escrita por un backend anterior a la tabla)
   * responde esa única foto.
   */
  private async toResponseDto(
    intervencion: SelectedIntervencion,
    nombres: Map<string, { nombre: string }>,
  ): Promise<IntervencionResponseDto> {
    const keys =
      intervencion.fotos.length > 0
        ? intervencion.fotos.map((foto) => foto.key)
        : intervencion.fotoKey
          ? [intervencion.fotoKey]
          : [];
    const fotoUrls = await Promise.all(
      keys.map((key) => this.storage.sign(key)),
    );
    return {
      id: intervencion.id,
      ordenId: intervencion.ordenId,
      tipo: intervencion.tipo,
      detalle: intervencion.detalle,
      horasHombre: intervencion.horasHombre,
      horometro: intervencion.horometro,
      fotoUrl: fotoUrls[0] ?? null,
      fotoUrls,
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
