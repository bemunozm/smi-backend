import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Hallazgo } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
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

/**
 * Forma de un hallazgo en la API — nunca expone `fotoKey`, igual que
 * `CombustibleResponse`: `fotoUrl` es la key firmada cuando hay `fotoKey`, o
 * el valor legacy tal cual cuando el registro no tiene key.
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
    if (dto.fotoUrl && dto.fotoKey) {
      throw new BadRequestException(
        'No se puede enviar "fotoUrl" y "fotoKey" juntos',
      );
    }

    const equipo = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    // Se reclama ANTES del `create` y fuera del try, igual que en
    // `CombustibleService`: si el claim falla, todavía no hay fila que revertir.
    const finalKey = dto.fotoKey
      ? await this.storage.claimTmp(dto.fotoKey, userId, 'hallazgo-photo')
      : undefined;

    let hallazgo: Hallazgo;
    try {
      hallazgo = await this.prisma.hallazgo.create({
        data: {
          equipoId: dto.equipoId,
          descripcion: dto.descripcion,
          prioridad: dto.prioridad,
          estado: 'ABIERTO',
          fotoUrl: dto.fotoUrl ?? null,
          fotoKey: finalKey ?? null,
        },
      });
    } catch (error: unknown) {
      // El objeto ya está reclamado en el bucket: si la fila no se escribe,
      // queda huérfano y hay que soltarlo.
      if (finalKey) {
        await this.storage.discard(finalKey);
      }
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
      include: { equipo: { select: { internalCode: true } } },
    });
    return Promise.all(registros.map((r) => this.shape(r)));
  }

  async findOne(id: string) {
    const reg = await this.prisma.hallazgo.findUnique({ where: { id } });
    if (!reg) throw new NotFoundException('Hallazgo no encontrado');
    return this.shape(reg);
  }

  /**
   * Edita un hallazgo ya registrado (Acta N.° 004, R13).
   *
   * Sin autorización, pero no silencioso: lo que cambió queda en `ChangeLog`
   * —en la misma transacción que la edición— y el administrador recibe un
   * aviso con cada dato y su antes y después. Si nada cambió de verdad, no se
   * escribe ni se avisa.
   */
  async update(id: string, dto: UpdateHallazgoDto, editor: Editor) {
    const actual = await this.prisma.hallazgo.findUnique({
      where: { id },
      include: { equipo: { select: { internalCode: true } } },
    });
    if (!actual) throw new NotFoundException('Hallazgo no encontrado');

    let codigoNuevo = actual.equipo.internalCode;
    if (dto.equipoId && dto.equipoId !== actual.equipoId) {
      const equipo = await this.prisma.equipment.findUnique({
        where: { id: dto.equipoId },
      });
      if (!equipo) throw new NotFoundException('Equipo no encontrado');
      codigoNuevo = equipo.internalCode;
    }

    const nuevo: DatosHallazgo = {
      equipoId: dto.equipoId ?? actual.equipoId,
      descripcion: dto.descripcion?.trim() ?? actual.descripcion,
      prioridad: dto.prioridad ?? actual.prioridad,
      estado: dto.estado ?? actual.estado,
    };

    const codigos: Record<string, string> = {
      [actual.equipoId]: actual.equipo.internalCode,
      [nuevo.equipoId]: codigoNuevo,
    };
    const cambios = diffFields<DatosHallazgo>(actual, nuevo, [
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
      { field: 'estado', label: 'Estado', format: (v) => ESTADO_LABEL[v] ?? v },
    ]);
    if (cambios.length === 0) return this.shape(actual);

    const editado = await this.prisma.$transaction(async (tx) => {
      const reg = await tx.hallazgo.update({
        where: { id },
        data: nuevo,
        include: { equipo: { select: { internalCode: true } } },
      });
      await this.changeLog.record(tx, 'hallazgo', id, editor, cambios);
      return reg;
    });

    this.eventEmitter.emit(DOMAIN_EVENTS.RECORD_EDITED, {
      entity: 'hallazgo',
      entityId: id,
      entityLabel: `hallazgo de ${codigoNuevo} del ${actual.fecha.toLocaleDateString('es-CL')}`,
      editedBy: editor.name,
      changes: cambios.map(({ label, before, after }) => ({
        label,
        before,
        after,
      })),
    } satisfies RecordEditedEvent);

    return this.shape(editado);
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
