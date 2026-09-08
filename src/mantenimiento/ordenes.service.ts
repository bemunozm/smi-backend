import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EstadoOT } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
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
  titulo: true,
  estado: true,
  prioridad: true,
  tipo: true,
  origen: true,
  origenDetalle: true,
  createdAt: true,
  updatedAt: true,
  tareas: {
    select: { id: true, texto: true, hecha: true, posicion: true },
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
} satisfies Prisma.TareaOTSelect;

@Injectable()
export class OrdenesService {
  private readonly logger = new Logger(OrdenesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
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

    return ordenes.map((orden) => this.toResponseDto(orden, asignados));
  }

  async findOne(id: string): Promise<OrdenResponseDto> {
    const orden = await this.findOrdenOrThrow(id);
    const asignados = await resolveAsignadosMap(this.prisma, [
      orden.asignadoAId,
    ]);
    return this.toResponseDto(orden, asignados);
  }

  async create(dto: CreateOrdenDto): Promise<OrdenResponseDto> {
    const orden = await this.prisma.ordenTrabajo.create({
      data: {
        equipoId: dto.equipoId,
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
      },
      select: ORDEN_SELECT,
    });

    this.logger.log(`Orden de trabajo creada: ${orden.id}`);

    const asignados = await resolveAsignadosMap(this.prisma, [
      orden.asignadoAId,
    ]);
    return this.toResponseDto(orden, asignados);
  }

  async update(id: string, dto: UpdateOrdenDto): Promise<OrdenResponseDto> {
    const ordenAnterior = await this.findOrdenOrThrow(id);

    const orden = await this.prisma.ordenTrabajo.update({
      where: { id },
      data: {
        estado: dto.estado,
        asignadoAId: dto.asignadoAId,
        prioridad: dto.prioridad,
        titulo: dto.titulo,
      },
      select: ORDEN_SELECT,
    });

    this.logger.log(`Orden de trabajo actualizada: ${id}`);

    this.emitTransicionEstado(ordenAnterior.estado, orden);

    const asignados = await resolveAsignadosMap(this.prisma, [
      orden.asignadoAId,
    ]);
    return this.toResponseDto(orden, asignados);
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

  async toggleTarea(
    ordenId: string,
    tareaId: string,
    hecha: boolean,
  ): Promise<TareaResponseDto> {
    const tarea = await this.prisma.tareaOT.findUnique({
      where: { id: tareaId },
      select: { id: true, ordenId: true },
    });

    if (!tarea || tarea.ordenId !== ordenId) {
      throw new NotFoundException(
        `Tarea con id "${tareaId}" no encontrada en la orden "${ordenId}"`,
      );
    }

    const updated = await this.prisma.tareaOT.update({
      where: { id: tareaId },
      data: { hecha },
      select: TAREA_SELECT,
    });

    this.logger.log(
      `Tarea ${tareaId} de la orden ${ordenId} marcada hecha=${hecha}`,
    );

    return updated;
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

  private toResponseDto(
    orden: SelectedOrden,
    asignados: Map<string, AsignadoResponseDto>,
  ): OrdenResponseDto {
    return {
      id: orden.id,
      equipoId: orden.equipoId,
      titulo: orden.titulo,
      estado: orden.estado,
      prioridad: orden.prioridad,
      tipo: orden.tipo,
      origen: orden.origen,
      origenDetalle: orden.origenDetalle,
      asignadoA: orden.asignadoAId
        ? (asignados.get(orden.asignadoAId) ?? null)
        : null,
      tareas: orden.tareas.map((tarea) => ({
        id: tarea.id,
        texto: tarea.texto,
        hecha: tarea.hecha,
        posicion: tarea.posicion,
      })),
      createdAt: orden.createdAt.toISOString(),
      updatedAt: orden.updatedAt.toISOString(),
    };
  }
}
