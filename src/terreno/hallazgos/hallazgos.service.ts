import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { Hallazgo } from '@prisma/client';

import { assertExpectedLocked } from '../../common/concurrency/assert-expected-locked';
import { type ExpectedValues } from '../../common/concurrency/expected-fields';
import { createOrReturn } from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { resolveRecordDate } from '../../common/dates/capture-time';
import {
  businessDayInstant,
  formatBusinessDate,
} from '../../common/dates/business-time';
import {
  assertShiftDateWithinWindow,
  isDateOnlyString,
} from '../../shifts/date-only';
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
import { resolveNombresUsuarios } from '../common/registrado-por.util';
import { CreateHallazgoDto } from './dto/create-hallazgo.dto';
import { UpdateHallazgoDto } from './dto/update-hallazgo.dto';
import { nombreZona } from './hallazgo-tipo';

/** Los datos de un hallazgo que se pueden corregir. */
type DatosHallazgo = Pick<
  Hallazgo,
  'equipoId' | 'faena' | 'lugar' | 'descripcion' | 'prioridad' | 'estado'
>;

/** Cómo se nombra cada dato en el mensaje de conflicto (`STALE_UPDATE`). */
const CAMPO_LABEL: Record<keyof DatosHallazgo, string> = {
  equipoId: 'Equipo',
  faena: 'Faena',
  lugar: 'Lugar',
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
    faena: dto.faena ?? actual.faena,
    lugar: dto.lugar?.trim() ?? actual.lugar,
    descripcion: dto.descripcion?.trim() ?? actual.descripcion,
    prioridad: dto.prioridad ?? actual.prioridad,
    estado: dto.estado ?? actual.estado,
  };
}

/** Solo los campos que admiten precondición `X-Expected`. */
function datosDe(h: DatosHallazgo): DatosHallazgo {
  return {
    equipoId: h.equipoId,
    faena: h.faena,
    lugar: h.lugar,
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

/**
 * El cliente omite `createdById` en TODAS las consultas (`PrismaService`,
 * para que nunca salga crudo en una respuesta). `registradoPor` se resuelve
 * desde ese id, así que las consultas que arman la respuesta lo piden explícito:
 * sin esto, «Registrado por» salía vacío siempre, también en los registros nuevos.
 */
const CON_DUENO = { createdById: false } as const;

/** La fila completa con su equipo — `shape` la convierte en la forma de la API. */
type HallazgoWithEquipo = Prisma.HallazgoGetPayload<{
  include: typeof HALLAZGO_INCLUDE;
}>;

/**
 * Forma de un hallazgo en la API — nunca expone `fotoKey` (igual que
 * `CombustibleResponse`: `fotoUrl` es la key firmada cuando hay `fotoKey`, o
 * el valor legacy tal cual cuando el registro no tiene key) ni `createdById`
 * crudo: en su lugar va `registradoPor`, el nombre resuelto de quien lo
 * registró (null si la cuenta ya no existe).
 */
export type HallazgoResponse<T> = Omit<T, 'fotoKey' | 'createdById'> & {
  fotoUrl: string | null;
  registradoPor: string | null;
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
    // `fecha` date-only = carga histórica de Terreno: ventana de 30 días y
    // el instante se guarda DENTRO de ese día de negocio (por donde agrupan
    // el dashboard y los filtros del admin) — por `resolveRecordDate` un
    // date-only caería a medianoche UTC, el día ANTERIOR en Chile. Con hora
    // (panel del admin) o sin `fecha`, la ruta de siempre.
    let fecha: Date;
    if (dto.fecha && isDateOnlyString(dto.fecha)) {
      assertShiftDateWithinWindow(dto.fecha);
      fecha = businessDayInstant(dto.fecha);
    } else {
      fecha = resolveRecordDate(dto.fecha, dto.capturedAt);
    }

    // De zona: sin equipo, con su faena y lugar (el DTO ya exige ambos). De
    // equipo, el de siempre: el equipo tiene que existir.
    const esZona = dto.tipo === 'ZONA';
    if (esZona && dto.equipoId) {
      throw new BadRequestException(
        'Un hallazgo de zona no lleva equipo: indica la faena y el lugar.',
      );
    }
    const equipo = esZona
      ? null
      : await this.prisma.equipment.findUnique({
          where: { id: dto.equipoId },
        });
    if (!esZona && !equipo) throw new NotFoundException('Equipo no encontrado');

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
          tipo: esZona ? 'ZONA' : 'EQUIPO',
          equipoId: esZona ? null : dto.equipoId,
          faena: esZona ? dto.faena : null,
          lugar: esZona ? dto.lugar?.trim() : null,
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
        omit: CON_DUENO,
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
      tipo: esZona ? 'ZONA' : 'EQUIPO',
      zona: esZona ? nombreZona(hallazgo.faena, hallazgo.lugar) : null,
      equipoId: hallazgo.equipoId,
      equipoCodigo: equipo?.internalCode ?? null,
      prioridad: hallazgo.prioridad,
      descripcion: hallazgo.descripcion,
    } satisfies HallazgoCreatedEvent);

    const nombres = await resolveNombresUsuarios(this.prisma, [userId]);
    return this.shape(hallazgo, nombres);
  }

  async findAll() {
    const registros = await this.prisma.hallazgo.findMany({
      orderBy: { fecha: 'desc' },
      include: HALLAZGO_INCLUDE,
      omit: CON_DUENO,
    });
    const nombres = await resolveNombresUsuarios(
      this.prisma,
      registros.map((r) => r.createdById),
    );
    return Promise.all(registros.map((r) => this.shape(r, nombres)));
  }

  async findOne(id: string) {
    const reg = await this.prisma.hallazgo.findUnique({
      where: { id },
      include: HALLAZGO_INCLUDE,
      omit: CON_DUENO,
    });
    if (!reg) throw new NotFoundException('Hallazgo no encontrado');
    const nombres = await resolveNombresUsuarios(this.prisma, [
      reg.createdById,
    ]);
    return this.shape(reg, nombres);
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
              omit: CON_DUENO,
            }),
          comparable: datosDe,
          desired: (actual) => ({ ...mergeDatos(actual, dto) }),
          labels: CAMPO_LABEL,
          notFoundMessage: 'Hallazgo no encontrado',
        });
        // El tipo no se cambia: cada uno corrige lo suyo.
        if (vigente.tipo === 'ZONA' && dto.equipoId !== undefined) {
          throw new BadRequestException('Un hallazgo de zona no lleva equipo.');
        }
        if (
          vigente.tipo !== 'ZONA' &&
          (dto.faena !== undefined || dto.lugar !== undefined)
        ) {
          throw new BadRequestException(
            'Un hallazgo de equipo no lleva faena ni lugar.',
          );
        }
        const nuevo = mergeDatos(vigente, dto);
        const codigoNuevo =
          vigente.tipo === 'ZONA'
            ? nombreZona(nuevo.faena, nuevo.lugar)
            : (equipoNuevo?.internalCode ??
              vigente.equipo?.internalCode ??
              '—');

        const codigos: Record<string, string> = {};
        if (vigente.equipoId && vigente.equipo) {
          codigos[vigente.equipoId] = vigente.equipo.internalCode;
        }
        if (nuevo.equipoId && equipoNuevo) {
          codigos[nuevo.equipoId] = equipoNuevo.internalCode;
        }
        const diff = diffFields<DatosHallazgo>(vigente, nuevo, [
          {
            field: 'equipoId',
            label: 'Equipo',
            format: (v) => (v ? (codigos[v] ?? v) : '—'),
          },
          { field: 'faena', label: 'Faena', format: (v) => v ?? '—' },
          { field: 'lugar', label: 'Lugar', format: (v) => v ?? '—' },
          { field: 'descripcion', label: 'Descripción' },
          {
            field: 'prioridad',
            label: 'Prioridad',
            format: (v) => (v ? (PRIORIDAD_LABEL[v] ?? v) : '—'),
          },
          {
            field: 'estado',
            label: 'Estado',
            format: (v) => (v ? (ESTADO_LABEL[v] ?? v) : '—'),
          },
        ]);
        if (diff.length === 0) {
          return { registro: vigente, cambios: diff, codigo: codigoNuevo };
        }

        const editado = await tx.hallazgo.update({
          where: { id },
          data: nuevo,
          include: HALLAZGO_INCLUDE,
          omit: CON_DUENO,
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

    const nombres = await resolveNombresUsuarios(this.prisma, [
      registro.createdById,
    ]);
    return this.shape(registro, nombres);
  }

  /** Los cambios de un hallazgo, del más reciente al más viejo. */
  findChanges(id: string) {
    return this.changeLog.findFor('hallazgo', id);
  }

  /**
   * Elimina un hallazgo — solo el administrador (ver controller). La foto del
   * bucket se suelta best-effort DESPUÉS de borrar la fila (si el borrado
   * falla, la foto sigue donde debe). Las OT/actividades que lo referencian
   * son soft refs (`hallazgoId` sin FK) y conservan su valor; el historial de
   * cambios (`ChangeLog`) también se conserva como traza, y el borrado deja
   * su PROPIA fila ahí (action `DELETE`, con el resumen de lo borrado): sin
   * ella, un registro eliminado desaparecía sin rastro de quién lo sacó — es
   * lo que el registro de actividad del administrador muestra.
   */
  async remove(id: string, editor: Editor) {
    const registro = await this.prisma.hallazgo.findUnique({
      where: { id },
      select: {
        fotoKey: true,
        tipo: true,
        faena: true,
        lugar: true,
        descripcion: true,
        prioridad: true,
        estado: true,
        fecha: true,
        equipo: { select: { internalCode: true } },
      },
    });
    if (!registro) throw new NotFoundException('Hallazgo no encontrado');

    // Qué decía el hallazgo al borrarlo, ya legible — el `before` del
    // historial. `after` queda en «—»: después del borrado no hay registro.
    const borrado = (label: string, before: string) => ({
      field: label.toLowerCase(),
      label,
      before,
      after: '—',
    });
    const resumen = [
      borrado(
        registro.tipo === 'ZONA' ? 'Zona' : 'Equipo',
        registro.tipo === 'ZONA'
          ? nombreZona(registro.faena, registro.lugar)
          : (registro.equipo?.internalCode ?? '—'),
      ),
      borrado('Descripción', registro.descripcion),
      borrado(
        'Prioridad',
        PRIORIDAD_LABEL[registro.prioridad] ?? registro.prioridad,
      ),
      borrado('Estado', ESTADO_LABEL[registro.estado] ?? registro.estado),
      borrado('Fecha', formatBusinessDate(registro.fecha)),
    ];

    await this.prisma.$transaction(async (tx) => {
      await this.changeLog.record(
        tx,
        'hallazgo',
        id,
        editor,
        resumen,
        'DELETE',
      );
      await tx.hallazgo.delete({ where: { id } });
    });

    if (registro.fotoKey) {
      await this.storage.deleteBestEffort(registro.fotoKey);
    }
  }

  /**
   * Nunca devuelve `fotoKey` — solo `fotoUrl`, firmada cuando el registro
   * tiene key (subida nueva por R2/MinIO) o el valor legacy tal cual (subida
   * vieja por `/api/uploads`). `createdById` tampoco sale crudo: viaja como
   * `registradoPor` (el nombre, resuelto por el caller con
   * `resolveNombresUsuarios`). Genérico sobre `T` para no perder los campos
   * extra que traiga la fila, como el `equipo: { internalCode }` de `findAll`.
   */
  private async shape<
    T extends {
      fotoUrl: string | null;
      fotoKey: string | null;
      createdById: string | null;
    },
  >(registro: T, nombres: Map<string, string>): Promise<HallazgoResponse<T>> {
    const { fotoKey, fotoUrl, createdById, ...resto } = registro;
    return {
      ...resto,
      registradoPor: (createdById && nombres.get(createdById)) || null,
      fotoUrl: fotoKey ? await this.storage.sign(fotoKey) : fotoUrl,
    } as HallazgoResponse<T>;
  }
}
