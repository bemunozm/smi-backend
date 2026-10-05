import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { Hallazgo } from '@prisma/client';

import { assertExpectedLocked } from '../../common/concurrency/assert-expected-locked';
import { type ExpectedValues } from '../../common/concurrency/expected-fields';
import { createOrReturn } from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { resolveCapturedAt } from '../../common/dates/capture-time';
import { formatBusinessDate } from '../../common/dates/business-time';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import type {
  HallazgoCreatedEvent,
  RecordEditedEvent,
} from '../../common/events/domain-events';
import {
  ChangeLogService,
  diffFields,
  type Editor,
} from '../../change-log/change-log.service';
import { StorageService } from '../../storage/storage.service';
import { CreateHallazgoDto } from './dto/create-hallazgo.dto';
import { UpdateHallazgoDto } from './dto/update-hallazgo.dto';

/** Los datos de un hallazgo que se pueden corregir. */
type DatosHallazgo = Pick<
  Hallazgo,
  'equipoId' | 'descripcion' | 'prioridad' | 'estado'
>;

/** Cómo se nombra cada dato en el mensaje de conflicto (`STALE_UPDATE`). */
const CAMPO_LABEL: Record<keyof DatosHallazgo, string> = {
  equipoId: 'Equipo',
  descripcion: 'Descripción',
  prioridad: 'Prioridad',
  estado: 'Estado',
};

/** Cómo se leen en el registro de cambios y en el aviso al administrador. */
const PRIORIDAD_LABEL: Record<string, string> = {
  BAJA: 'Baja',
  MEDIA: 'Media',
  ALTA: 'Alta',
  CRITICA: 'Crítica',
};
const ESTADO_LABEL: Record<string, string> = {
  ABIERTO: 'Abierto',
  EN_PROCESO: 'En proceso',
  CERRADO: 'Cerrado',
};

/** Los datos de un hallazgo tal como quedarían después de aplicar el body. */
function mergeDatos(
  actual: DatosHallazgo,
  dto: UpdateHallazgoDto,
): DatosHallazgo {
  return {
    equipoId: dto.equipoId ?? actual.equipoId,
    descripcion: dto.descripcion?.trim() ?? actual.descripcion,
    prioridad: dto.prioridad ?? actual.prioridad,
    estado: dto.estado ?? actual.estado,
  };
}

/** Solo los campos que admiten precondición `X-Expected`. */
function datosDe(h: DatosHallazgo): DatosHallazgo {
  return {
    equipoId: h.equipoId,
    descripcion: h.descripcion,
    prioridad: h.prioridad,
    estado: h.estado,
  };
}

/**
 * Relación que toda lectura/escritura devuelve. Una sola definición para que
 * `create`, `findAll`, `findOne` y `update` entreguen la misma forma: el
 * outbox offline de la tablet inserta la respuesta de `create` en la misma
 * caché que alimenta el listado, y sin `equipo` la fila mostraría el
 * `equipoId` crudo en vez del código interno.
 */
const HALLAZGO_INCLUDE = {
  equipo: { select: { internalCode: true } },
} satisfies Prisma.HallazgoInclude;

/** Un hallazgo tal como sale a la API: sin `createdById`. */
type HallazgoWithEquipo = Omit<
  Prisma.HallazgoGetPayload<{ include: typeof HALLAZGO_INCLUDE }>,
  'createdById'
>;

/**
 * Forma de un hallazgo en la API — nunca expone `fotoKey` (igual que
 * `CombustibleResponse`: `fotoUrl` es la key firmada cuando hay `fotoKey`, o
 * el valor legacy tal cual cuando el registro no tiene key).
 */
export type HallazgoResponse<T> = Omit<T, 'fotoKey'> & {
  fotoUrl: string | null;
};

@Injectable()
export class HallazgosService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private readonly storage: StorageService,
    private readonly changeLog: ChangeLogService,
  ) {}

  async create(dto: CreateHallazgoDto, userId: string) {
    // La búsqueda por id va PRIMERO y antes de cualquier regla: un reintento
    // offline debe devolver la fila ya creada aunque el estado del mundo haya
    // cambiado desde entonces (equipo dado de baja, key tmp ya reclamada) — y
    // sin repetir el claim ni el evento.
    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe un hallazgo con ese id de otro usuario',
      findExisting: async (id) => {
        const owner = await this.prisma.hallazgo.findUnique({
          where: { id },
          select: { createdById: true },
        });
        if (!owner) return null;
        return {
          ownerId: owner.createdById,
          result: () => this.findOne(id),
        };
      },
      create: () => this.createFresh(dto, userId),
    });
  }

  private async createFresh(dto: CreateHallazgoDto, userId: string) {
    const { at: fecha } = resolveCapturedAt(dto.capturedAt);

    const equipo = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    // Se reclama ANTES del `create` y fuera del try, igual que en
    // `CombustibleService`: si el claim falla, todavía no hay fila que revertir.
    const finalKey = dto.fotoKey
      ? await this.storage.claimTmp(dto.fotoKey, userId, 'hallazgo-photo')
      : undefined;

    let hallazgo: HallazgoWithEquipo;
    try {
      hallazgo = await this.prisma.hallazgo.create({
        data: {
          ...(dto.id ? { id: dto.id } : {}),
          equipoId: dto.equipoId,
          descripcion: dto.descripcion,
          prioridad: dto.prioridad,
          estado: 'ABIERTO',
          // `fotoUrl` (legacy) no es un campo de creación — ver
          // `CreateHallazgoDto`. Se omite la key: Prisma inserta NULL.
          fotoKey: finalKey ?? null,
          createdById: userId,
          fecha,
        },
        include: HALLAZGO_INCLUDE,
      });
    } catch (error: unknown) {
      // El objeto ya está reclamado en el bucket: si la fila no se escribe,
      // queda huérfano y hay que soltarlo.
      if (finalKey) {
        await this.storage.discard(finalKey);
      }
      // En una carrera con el MISMO id, `createOrReturn` relee la fila
      // ganadora; la foto reclamada por este intento ya se soltó y la fila
      // ganadora conserva la suya.
      throw error;
    }

    this.eventEmitter.emit(DOMAIN_EVENTS.HALLAZGO_CREATED, {
      hallazgoId: hallazgo.id,
      equipoId: hallazgo.equipoId,
      equipoCodigo: equipo.internalCode,
      prioridad: hallazgo.prioridad,
      descripcion: hallazgo.descripcion,
    } satisfies HallazgoCreatedEvent);

    return this.shape(hallazgo);
  }

  async findAll() {
    const registros = await this.prisma.hallazgo.findMany({
      orderBy: { fecha: 'desc' },
      include: HALLAZGO_INCLUDE,
    });
    return Promise.all(registros.map((r) => this.shape(r)));
  }

  async findOne(id: string) {
    const reg = await this.prisma.hallazgo.findUnique({
      where: { id },
      include: HALLAZGO_INCLUDE,
    });
    if (!reg) throw new NotFoundException('Hallazgo no encontrado');
    return this.shape(reg);
  }

  /**
   * Edita un hallazgo ya registrado.
   *
   * Sin autorización, pero no silencioso: lo que cambió queda en `ChangeLog`
   * —en la misma transacción que la edición— y el administrador recibe un
   * aviso con cada dato y su antes y después. Si nada cambió de verdad, no se
   * escribe ni se avisa.
   */
  async update(
    id: string,
    dto: UpdateHallazgoDto,
    editor: Editor,
    expected?: ExpectedValues,
  ) {
    let equipoNuevo: { internalCode: string } | null = null;
    if (dto.equipoId) {
      equipoNuevo = await this.prisma.equipment.findUnique({
        where: { id: dto.equipoId },
        select: { internalCode: true },
      });
      if (!equipoNuevo) throw new NotFoundException('Equipo no encontrado');
    }

    const { registro, cambios, codigo } = await this.prisma.$transaction(
      async (tx) => {
        // Todo se calcula sobre la fila vigente, leída con el bloqueo tomado:
        // una edición ajena de OTRO campo, confirmada antes de este bloqueo,
        // no se revierte al escribir ni queda mal registrada en el historial.
        const vigente = await assertExpectedLocked({
          tx,
          table: 'hallazgo',
          id,
          expected,
          read: (t) =>
            t.hallazgo.findUnique({
              where: { id },
              include: HALLAZGO_INCLUDE,
            }),
          comparable: datosDe,
          desired: (actual) => ({ ...mergeDatos(actual, dto) }),
          labels: CAMPO_LABEL,
          notFoundMessage: 'Hallazgo no encontrado',
        });
        const nuevo = mergeDatos(vigente, dto);
        const codigoNuevo =
          equipoNuevo?.internalCode ?? vigente.equipo.internalCode;

        const codigos: Record<string, string> = {
          [vigente.equipoId]: vigente.equipo.internalCode,
          [nuevo.equipoId]: codigoNuevo,
        };
        const diff = diffFields<DatosHallazgo>(vigente, nuevo, [
          {
            field: 'equipoId',
            label: 'Equipo',
            format: (v) => codigos[v] ?? v,
          },
          { field: 'descripcion', label: 'Descripción' },
          {
            field: 'prioridad',
            label: 'Prioridad',
            format: (v) => PRIORIDAD_LABEL[v] ?? v,
          },
          {
            field: 'estado',
            label: 'Estado',
            format: (v) => ESTADO_LABEL[v] ?? v,
          },
        ]);
        if (diff.length === 0) {
          return { registro: vigente, cambios: diff, codigo: codigoNuevo };
        }

        const editado = await tx.hallazgo.update({
          where: { id },
          data: nuevo,
          include: HALLAZGO_INCLUDE,
        });
        await this.changeLog.record(tx, 'hallazgo', id, editor, diff);
        return { registro: editado, cambios: diff, codigo: codigoNuevo };
      },
    );

    if (cambios.length > 0) {
      this.eventEmitter.emit(DOMAIN_EVENTS.RECORD_EDITED, {
        entity: 'hallazgo',
        entityId: id,
        entityArticle: 'el',
        entityLabel: `hallazgo de ${codigo} del ${formatBusinessDate(registro.fecha)}`,
        editedBy: editor.name,
        changes: cambios.map(({ label, before, after }) => ({
          label,
          before,
          after,
        })),
      } satisfies RecordEditedEvent);
    }

    return this.shape(registro);
  }

  /** Los cambios de un hallazgo, del más reciente al más viejo. */
  findChanges(id: string) {
    return this.changeLog.findFor('hallazgo', id);
  }

  /**
   * Nunca devuelve `fotoKey` — solo `fotoUrl`, firmada cuando el registro
   * tiene key (subida nueva por R2/MinIO) o el valor legacy tal cual (subida
   * vieja por `/api/uploads`). Genérico sobre `T` para no perder los campos
   * extra que traiga la fila, como el `equipo: { internalCode }` de `findAll`.
   */
  private async shape<
    T extends { fotoUrl: string | null; fotoKey: string | null },
  >(registro: T): Promise<HallazgoResponse<T>> {
    const { fotoKey, fotoUrl, ...resto } = registro;
    return {
      ...resto,
      fotoUrl: fotoKey ? await this.storage.sign(fotoKey) : fotoUrl,
    } as HallazgoResponse<T>;
  }
}
