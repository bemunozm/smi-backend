import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EstadoOT, MovementReason } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import {
  assertExpectedLocked,
  definedFields,
} from '../common/concurrency/assert-expected-locked';
import type { ExpectedValues } from '../common/concurrency/expected-fields';
import { createOrReturn } from '../common/idempotency/create-or-return';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  StockService,
  type PendingStockEvents,
} from '../inventory/stock.service';
import { StorageService } from '../storage/storage.service';
import { DOMAIN_EVENTS } from '../common/events/domain-events';
import type {
  OrdenAssignedEvent,
  OrdenCompletedEvent,
} from '../common/events/domain-events';
import { resolveAsignadosMap } from './common/asignado.util';
import type { AsignadoResponseDto } from './dto/asignado-response.dto';
import type { CreateOrdenDto } from './dto/create-orden.dto';
import type { OrdenResponseDto } from './dto/orden-response.dto';
import type { TareaResponseDto } from './dto/tarea-response.dto';
import type { UpdateOrdenDto } from './dto/update-orden.dto';

// `select` explícito (nunca el objeto Prisma crudo) — mismo criterio que
// `users.service.ts`: el shape público no se desincroniza en silencio si el
// modelo gana campos nuevos.
const ORDEN_SELECT = {
  id: true,
  equipoId: true,
  asignadoAId: true,
  hallazgoId: true,
  titulo: true,
  estado: true,
  prioridad: true,
  tipo: true,
  origen: true,
  origenDetalle: true,
  pautaMilestone: true,
  pautaCycle: true,
  createdAt: true,
  updatedAt: true,
  tareas: {
    select: {
      id: true,
      texto: true,
      hecha: true,
      posicion: true,
      planItemId: true,
      notas: true,
      fotoKey: true,
      hechaPorNombre: true,
      hechaAt: true,
    },
    orderBy: { posicion: 'asc' },
  },
} satisfies Prisma.OrdenTrabajoSelect;

type SelectedOrden = Prisma.OrdenTrabajoGetPayload<{
  select: typeof ORDEN_SELECT;
}>;

const TAREA_SELECT = {
  id: true,
  texto: true,
  hecha: true,
  posicion: true,
  notas: true,
  fotoKey: true,
  hechaPorNombre: true,
  hechaAt: true,
} satisfies Prisma.TareaOTSelect;

/** Cómo se nombra cada dato en el mensaje de conflicto (`STALE_UPDATE`). */
const CAMPO_LABEL: Record<string, string> = {
  estado: 'Estado',
  asignadoAId: 'Asignado a',
  prioridad: 'Prioridad',
  titulo: 'Título',
};

@Injectable()
export class OrdenesService {
  private readonly logger = new Logger(OrdenesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly storage: StorageService,
    private readonly stock: StockService,
  ) {}

  async findAll(estado?: EstadoOT): Promise<OrdenResponseDto[]> {
    const ordenes = await this.prisma.ordenTrabajo.findMany({
      where: estado ? { estado } : undefined,
      select: ORDEN_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    const asignados = await resolveAsignadosMap(
      this.prisma,
      ordenes.map((orden) => orden.asignadoAId),
    );

    return Promise.all(
      ordenes.map((orden) => this.toResponseDto(orden, asignados)),
    );
  }

  async findOne(id: string): Promise<OrdenResponseDto> {
    const orden = await this.findOrdenOrThrow(id);
    const asignados = await resolveAsignadosMap(this.prisma, [
      orden.asignadoAId,
    ]);
    return this.toResponseDto(orden, asignados);
  }

  async create(dto: CreateOrdenDto, userId: string): Promise<OrdenResponseDto> {
    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage:
        'Ya existe una orden de trabajo con ese id de otro usuario',
      findExisting: async (id) => {
        const owner = await this.prisma.ordenTrabajo.findUnique({
          where: { id },
          select: { createdById: true },
        });
        if (!owner) return null;
        return { ownerId: owner.createdById, result: () => this.findOne(id) };
      },
      create: () => this.createFresh(dto, userId),
    });
  }

  private async createFresh(
    dto: CreateOrdenDto,
    userId: string,
  ): Promise<OrdenResponseDto> {
    const data = {
      ...(dto.id ? { id: dto.id } : {}),
      createdById: userId,
      equipoId: dto.equipoId,
      hallazgoId: dto.hallazgoId,
      titulo: dto.titulo,
      prioridad: dto.prioridad,
      tipo: dto.tipo,
      origen: dto.origen,
      origenDetalle: dto.origenDetalle,
      asignadoAId: dto.asignadoAId,
      tareas: dto.tareas
        ? {
            create: dto.tareas.map((tarea, index) => ({
              texto: tarea.texto,
              posicion: index,
            })),
          }
        : undefined,
    } satisfies Prisma.OrdenTrabajoUncheckedCreateInput;

    let orden: SelectedOrden;
    if (dto.hallazgoId) {
      // Orden nacida de un hallazgo: tomarlo y marcarlo EN_PROCESO son UNA
      // sola cosa — si el hallazgo ya lo tomó otro (no está ABIERTO), no se
      // crea una segunda orden en silencio.
      const hallazgoId = dto.hallazgoId;
      orden = await this.prisma.$transaction(async (tx) => {
        const hallazgo = await tx.hallazgo.findUnique({
          where: { id: hallazgoId },
          select: { id: true },
        });
        if (!hallazgo) {
          throw new NotFoundException(
            `Hallazgo con id "${hallazgoId}" no encontrado`,
          );
        }
        // Claim CONDICIONAL atómico: "tómalo solo si sigue ABIERTO". Dos
        // creates concurrentes sobre el mismo hallazgo no pueden ganar los
        // dos — el que llega segundo ve count 0 y pierde limpio, sin dejar
        // una segunda OT ligada en silencio.
        const claimed = await tx.hallazgo.updateMany({
          where: { id: hallazgoId, estado: 'ABIERTO' },
          data: { estado: 'EN_PROCESO' },
        });
        if (claimed.count === 0) {
          throw new ConflictException(
            'El hallazgo ya está en proceso o cerrado',
          );
        }
        return tx.ordenTrabajo.create({
          data,
          select: ORDEN_SELECT,
        });
      });
    } else {
      orden = await this.prisma.ordenTrabajo.create({
        data,
        select: ORDEN_SELECT,
      });
    }

    this.logger.log(`Orden de trabajo creada: ${orden.id}`);

    const asignados = await resolveAsignadosMap(this.prisma, [
      orden.asignadoAId,
    ]);
    return this.toResponseDto(orden, asignados);
  }

  async update(
    id: string,
    dto: UpdateOrdenDto,
    expected?: ExpectedValues,
  ): Promise<OrdenResponseDto> {
    const ordenAnterior = await this.findOrdenOrThrow(id);

    const write = (db: Prisma.TransactionClient) =>
      db.ordenTrabajo.update({
        where: { id },
        data: {
          estado: dto.estado,
          asignadoAId: dto.asignadoAId,
          prioridad: dto.prioridad,
          titulo: dto.titulo,
        },
        select: ORDEN_SELECT,
      });

    let orden: SelectedOrden;
    let estadoAnterior = ordenAnterior.estado;
    if (!expected) {
      // La escritura y la transición del hallazgo ligado van juntas: una
      // orden completada cuyo hallazgo quedó ABIERTO contaría dos historias.
      orden = await this.prisma.$transaction(async (tx) => {
        const actualizada = await write(tx);
        await this.syncHallazgoEstado(tx, actualizada, estadoAnterior);
        return actualizada;
      });
    } else {
      // El estado previo se toma bajo el bloqueo: es el que decide si hubo
      // transición (y por lo tanto aviso), no el de la lectura de arriba.
      ({ orden, estadoAnterior } = await this.prisma.$transaction(
        async (tx) => {
          const vigente = await assertExpectedLocked({
            tx,
            table: 'ordenTrabajo',
            id,
            expected,
            read: (db) =>
              db.ordenTrabajo.findUnique({
                where: { id },
                select: {
                  estado: true,
                  asignadoAId: true,
                  prioridad: true,
                  titulo: true,
                },
              }),
            desired: definedFields(dto),
            labels: CAMPO_LABEL,
            notFoundMessage: `Orden de trabajo con id "${id}" no encontrada`,
          });
          const actualizada = await write(tx);
          await this.syncHallazgoEstado(tx, actualizada, vigente.estado);
          return { orden: actualizada, estadoAnterior: vigente.estado };
        },
      ));
    }

    this.logger.log(`Orden de trabajo actualizada: ${id}`);

    // Después del commit: un aviso de una escritura que se revierte avisaría
    // de un cambio que nunca existió.
    this.emitTransicionEstado(estadoAnterior, orden);

    const asignados = await resolveAsignadosMap(this.prisma, [
      orden.asignadoAId,
    ]);
    return this.toResponseDto(orden, asignados);
  }

  /**
   * Mantiene el hallazgo ligado contando la misma historia que su orden:
   * COMPLETADA → CERRADO · CANCELADA → ABIERTO (vuelve a la bandeja del
   * taller). Solo en el CRUCE de estado — editar el título no lo toca.
   */
  private async syncHallazgoEstado(
    tx: Prisma.TransactionClient,
    orden: SelectedOrden,
    estadoAnterior: EstadoOT,
  ): Promise<void> {
    if (!orden.hallazgoId || orden.estado === estadoAnterior) return;

    const estadoHallazgo =
      orden.estado === EstadoOT.COMPLETADA
        ? 'CERRADO'
        : orden.estado === EstadoOT.CANCELADA
          ? 'ABIERTO'
          : null;
    if (!estadoHallazgo) return;

    // Condicionado a EN_PROCESO: si el supervisor ya lo cerró (o reabrió) a
    // mano, la transición de la orden no le pisa esa decisión.
    await tx.hallazgo.updateMany({
      where: { id: orden.hallazgoId, estado: 'EN_PROCESO' },
      data: { estado: estadoHallazgo },
    });
  }

  /**
   * Emite el evento de dominio correspondiente SOLO en el cruce de estado
   * (evita spam si `update` se llama sin cambiar `estado`, p.ej. solo
   * cambia el título). Fire-and-forget (`emit`, no `emitAsync`): la latencia
   * de notificación/correo no debe acoplarse a la respuesta del request.
   */
  private emitTransicionEstado(
    estadoAnterior: EstadoOT,
    orden: SelectedOrden,
  ): void {
    if (orden.estado === estadoAnterior) return;

    if (orden.estado === EstadoOT.ASIGNADA) {
      this.eventEmitter.emit(DOMAIN_EVENTS.ORDEN_ASSIGNED, {
        ordenId: orden.id,
        equipoId: orden.equipoId,
        asignadoId: orden.asignadoAId,
        titulo: orden.titulo,
      } satisfies OrdenAssignedEvent);
    } else if (orden.estado === EstadoOT.COMPLETADA) {
      this.eventEmitter.emit(DOMAIN_EVENTS.ORDEN_COMPLETED, {
        ordenId: orden.id,
        equipoId: orden.equipoId,
        titulo: orden.titulo,
      } satisfies OrdenCompletedEvent);
    }
  }

  /**
   * Marca/desmarca una tarea del checklist de la orden, con las notas de qué
   * se hizo y su foto de respaldo (taller). En las órdenes PREVENTIVAS que
   * nacen de la pauta (`pautaCycle`/`pautaMilestone`) hace dos cosas más, en
   * la MISMA transacción:
   *
   * 1. Escribe (o borra) el registro del ciclo (`MaintenanceRecord`): la
   *    grilla de la ficha del equipo y la tarjeta del tablero cuentan la
   *    misma historia, sin estados paralelos.
   * 2. Mueve la orden sola: con la primera tarea hecha pasa a EN_PROCESO, y
   *    con TODAS hechas a COMPLETADA — el mantenedor no cierra a mano.
   */
  async updateTarea(
    ordenId: string,
    tareaId: string,
    dto: {
      hecha: boolean;
      notas?: string;
      fotoKey?: string;
      insumos?: { insumoId: string; cantidad: number }[];
      branchId?: string;
    },
    editor: { id: string; name: string },
  ): Promise<TareaResponseDto> {
    const tarea = await this.prisma.tareaOT.findUnique({
      where: { id: tareaId },
      select: { id: true, ordenId: true, planItemId: true, texto: true },
    });

    if (!tarea || tarea.ordenId !== ordenId) {
      throw new NotFoundException(
        `Tarea con id "${tareaId}" no encontrada en la orden "${ordenId}"`,
      );
    }
    const ordenAnterior = await this.findOrdenOrThrow(ordenId);

    const insumos = dto.insumos ?? [];
    if (insumos.length > 0 && !dto.branchId) {
      throw new BadRequestException(
        'Indica la bodega de la que salen los insumos.',
      );
    }
    // Igual que en las intervenciones: `equipoId` de la OT es texto libre; si
    // se resuelve, el movimiento queda imputado a la unidad.
    const equipmentId =
      insumos.length > 0
        ? await this.resolveEquipmentId(ordenAnterior.equipoId)
        : null;

    // La foto se reclama ANTES de la transacción (mismo criterio que
    // `IntervencionesService`): si la escritura falla, se descarta.
    const finalKey = dto.fotoKey
      ? await this.storage.claimTmp(dto.fotoKey, editor.id, 'tarea-photo')
      : undefined;

    const events: PendingStockEvents = [];
    let updated: Prisma.TareaOTGetPayload<{ select: typeof TAREA_SELECT }>;
    let orden: SelectedOrden = ordenAnterior;
    try {
      ({ updated, orden } = await this.prisma.$transaction(async (tx) => {
        const tareaActualizada = await tx.tareaOT.update({
          where: { id: tareaId },
          data: {
            hecha: dto.hecha,
            ...(dto.notas !== undefined ? { notas: dto.notas } : {}),
            ...(finalKey !== undefined ? { fotoKey: finalKey } : {}),
            // El "ver detalle" de la tarjeta: quién y cuándo la completó.
            ...(dto.hecha
              ? { hechaPorNombre: editor.name, hechaAt: new Date() }
              : { hechaPorNombre: null, hechaAt: null }),
          },
          select: TAREA_SELECT,
        });

        // Los insumos de ESTA tarea salen del stock en la misma transacción
        // (contrato de `StockService.issue`): si algo falla, no se descuenta.
        for (const insumo of insumos) {
          await this.stock.issue(
            {
              itemId: insumo.insumoId,
              branchId: dto.branchId as string,
              quantity: insumo.cantidad,
              reason: MovementReason.INTERVENTION,
              performedById: editor.id,
              equipmentId,
              reference: ordenId,
            },
            { tx, events },
          );
        }

        await this.syncRegistroCiclo(
          tx,
          ordenAnterior,
          tarea,
          dto.hecha,
          editor,
        );

        // Transición automática SOLO en las órdenes de la pauta: en las
        // demás, el estado lo maneja quien trabaja la orden.
        let actualizada: SelectedOrden = ordenAnterior;
        if (ordenAnterior.pautaCycle != null) {
          const tareas = await tx.tareaOT.findMany({
            where: { ordenId },
            select: { hecha: true },
          });
          const hechas = tareas.filter((t) => t.hecha).length;
          const nuevoEstado =
            tareas.length > 0 && hechas === tareas.length
              ? EstadoOT.COMPLETADA
              : hechas > 0 &&
                  (ordenAnterior.estado === EstadoOT.PENDIENTE ||
                    ordenAnterior.estado === EstadoOT.ASIGNADA)
                ? EstadoOT.EN_PROCESO
                : null;
          if (nuevoEstado && nuevoEstado !== ordenAnterior.estado) {
            actualizada = await tx.ordenTrabajo.update({
              where: { id: ordenId },
              data: { estado: nuevoEstado },
              select: ORDEN_SELECT,
            });
          }
        }
        return { updated: tareaActualizada, orden: actualizada };
      }));
    } catch (error) {
      if (finalKey) await this.storage.discard(finalKey);
      throw error;
    }

    // Los avisos de stock bajo se emiten SOLO tras confirmar la transacción.
    this.stock.emitPending(events);

    this.logger.log(
      `Tarea ${tareaId} de la orden ${ordenId} marcada hecha=${dto.hecha}`,
    );
    // Después del commit, igual que `update`: la orden pudo cruzar de estado.
    this.emitTransicionEstado(ordenAnterior.estado, orden);

    return {
      id: updated.id,
      texto: updated.texto,
      hecha: updated.hecha,
      posicion: updated.posicion,
      notas: updated.notas,
      fotoUrl: updated.fotoKey
        ? await this.storage.sign(updated.fotoKey)
        : null,
      hechaPorNombre: updated.hechaPorNombre,
      hechaAt: updated.hechaAt ? updated.hechaAt.toISOString() : null,
    };
  }

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

  /**
   * El registro del ciclo que respalda la tarea (solo órdenes nacidas de la
   * pauta, con `planItemId`): marcarla lo escribe, desmarcarla lo borra. El
   * upsert no pisa quién/cuándo si ya estaba registrada desde la grilla.
   */
  private async syncRegistroCiclo(
    tx: Prisma.TransactionClient,
    orden: SelectedOrden,
    tarea: { planItemId: string | null; texto: string },
    hecha: boolean,
    editor: { id: string; name: string },
  ): Promise<void> {
    if (
      orden.pautaCycle == null ||
      orden.pautaMilestone == null ||
      !tarea.planItemId
    ) {
      return;
    }

    if (!hecha) {
      await tx.maintenanceRecord.deleteMany({
        where: {
          planItemId: tarea.planItemId,
          cycle: orden.pautaCycle,
          milestone: orden.pautaMilestone,
        },
      });
      return;
    }

    const planItem = await tx.maintenancePlanItem.findUnique({
      where: { id: tarea.planItemId },
      select: { description: true, kind: true },
    });
    const equipo = await tx.equipment.findUnique({
      where: { id: orden.equipoId },
      select: {
        controlUnit: true,
        currentHourmeter: true,
        currentMileage: true,
      },
    });
    const counterAt =
      equipo?.controlUnit === 'KM'
        ? (equipo?.currentMileage ?? null)
        : (equipo?.currentHourmeter ?? null);

    await tx.maintenanceRecord.upsert({
      where: {
        planItemId_cycle_milestone: {
          planItemId: tarea.planItemId,
          cycle: orden.pautaCycle,
          milestone: orden.pautaMilestone,
        },
      },
      create: {
        equipmentId: orden.equipoId,
        planItemId: tarea.planItemId,
        cycle: orden.pautaCycle,
        milestone: orden.pautaMilestone,
        description: planItem?.description ?? tarea.texto,
        kind: planItem?.kind ?? 'OTRO',
        counterAt,
        doneById: editor.id,
        doneByName: editor.name,
      },
      // Ya estaba hecha (p. ej. desde la grilla del ciclo): no se pisa.
      update: {},
    });
  }

  private async findOrdenOrThrow(id: string): Promise<SelectedOrden> {
    const orden = await this.prisma.ordenTrabajo.findUnique({
      where: { id },
      select: ORDEN_SELECT,
    });

    if (!orden) {
      throw new NotFoundException(
        `Orden de trabajo con id "${id}" no encontrada`,
      );
    }

    return orden;
  }

  // Async por la foto del checklist: la URL firmada se arma al responder y
  // nunca se expone la key cruda (mismo criterio que `IntervencionesService`).
  private async toResponseDto(
    orden: SelectedOrden,
    asignados: Map<string, AsignadoResponseDto>,
  ): Promise<OrdenResponseDto> {
    return {
      id: orden.id,
      equipoId: orden.equipoId,
      hallazgoId: orden.hallazgoId,
      titulo: orden.titulo,
      estado: orden.estado,
      prioridad: orden.prioridad,
      tipo: orden.tipo,
      origen: orden.origen,
      origenDetalle: orden.origenDetalle,
      pautaMilestone: orden.pautaMilestone,
      pautaCycle: orden.pautaCycle,
      asignadoA: orden.asignadoAId
        ? (asignados.get(orden.asignadoAId) ?? null)
        : null,
      tareas: await Promise.all(
        orden.tareas.map(async (tarea) => ({
          id: tarea.id,
          texto: tarea.texto,
          hecha: tarea.hecha,
          posicion: tarea.posicion,
          notas: tarea.notas,
          fotoUrl: tarea.fotoKey
            ? await this.storage.sign(tarea.fotoKey)
            : null,
          hechaPorNombre: tarea.hechaPorNombre,
          hechaAt: tarea.hechaAt ? tarea.hechaAt.toISOString() : null,
        })),
      ),
      createdAt: orden.createdAt.toISOString(),
      updatedAt: orden.updatedAt.toISOString(),
    };
  }
}
