import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { TrabajoExtraordinario } from '@prisma/client';

import { assertExpectedLocked } from '../../common/concurrency/assert-expected-locked';
import { type ExpectedValues } from '../../common/concurrency/expected-fields';
import { createOrReturn } from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { formatNumber } from '../../common/format/number';
import { OperatorsService } from '../../operators/operators.service';
import { resolveCapturedAt } from '../../common/dates/capture-time';
import { formatBusinessDate } from '../../common/dates/business-time';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import type { RecordEditedEvent } from '../../common/events/domain-events';
import {
  ChangeLogService,
  diffFields,
  type ComparableField,
  type Editor,
} from '../../change-log/change-log.service';
import {
  ACTIVIDAD_LABEL,
  CreateTrabajoExtraDto,
} from './dto/create-trabajo-extra.dto';
import { UpdateTrabajoExtraDto } from './dto/update-trabajo-extra.dto';

/**
 * Relación que toda lectura/escritura devuelve. Una sola definición para que
 * `create`, `findAll`, `findOne` y `update` entreguen la misma forma: el
 * outbox offline de la tablet inserta la respuesta de `create` en la misma
 * caché que alimenta el listado, y sin `equipo` la fila mostraría el
 * `equipoId` crudo en vez del código interno.
 */
const TRABAJO_EXTRA_INCLUDE = {
  equipo: { select: { internalCode: true } },
} satisfies Prisma.TrabajoExtraordinarioInclude;

/** Un trabajo tal como sale a la API: sin `createdById`. */
export type TrabajoExtraResponse = Omit<
  Prisma.TrabajoExtraordinarioGetPayload<{
    include: typeof TRABAJO_EXTRA_INCLUDE;
  }>,
  'createdById'
>;

/** Los datos de un trabajo que se pueden escribir, al crear o al editar. */
type DatosTrabajo = Pick<
  TrabajoExtraordinario,
  | 'equipoId'
  | 'operatorId'
  | 'operador'
  | 'faena'
  | 'turno'
  | 'horometroInicial'
  | 'horometroFinal'
  | 'totalHoras'
  | 'actividades'
  | 'otraActividad'
  | 'descripcion'
  | 'observaciones'
>;

/** Cómo se nombra cada dato en el mensaje de conflicto (`STALE_UPDATE`). */
const CAMPO_LABEL: Record<keyof DatosTrabajo, string> = {
  equipoId: 'Equipo',
  operatorId: 'Operador',
  operador: 'Operador',
  faena: 'Faena',
  turno: 'Turno',
  horometroInicial: 'Horómetro inicial',
  horometroFinal: 'Horómetro final',
  totalHoras: 'Total de horas',
  actividades: 'Actividades',
  otraActividad: 'Otra actividad',
  descripcion: 'Descripción',
  observaciones: 'Observaciones',
};

/** Solo los campos que admiten precondición `X-Expected`. */
function datosDe(t: DatosTrabajo): DatosTrabajo {
  return {
    equipoId: t.equipoId,
    operatorId: t.operatorId,
    operador: t.operador,
    faena: t.faena,
    turno: t.turno,
    horometroInicial: t.horometroInicial,
    horometroFinal: t.horometroFinal,
    totalHoras: t.totalHoras,
    actividades: t.actividades,
    otraActividad: t.otraActividad,
    descripcion: t.descripcion,
    observaciones: t.observaciones,
  };
}

const horas = (v: unknown) => `${formatNumber(Number(v))} h`;

@Injectable()
export class TrabajosExtraService {
  constructor(
    private prisma: PrismaService,
    private readonly operators: OperatorsService,
    private eventEmitter: EventEmitter2,
    private changeLog: ChangeLogService,
  ) {}

  async create(dto: CreateTrabajoExtraDto, userId: string) {
    // La búsqueda por id va PRIMERO y antes de cualquier regla: un reintento
    // offline debe devolver la fila ya creada aunque el estado del mundo haya
    // cambiado desde entonces (operador desactivado, turno abierto después,
    // etc.).
    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe un trabajo con ese id de otro usuario',
      findExisting: async (id) => {
        const owner = await this.prisma.trabajoExtraordinario.findUnique({
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

  private async createFresh(dto: CreateTrabajoExtraDto, userId: string) {
    const { at: fecha } = resolveCapturedAt(dto.capturedAt);

    const equipo = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    /**
     * Operador del catálogo — obligatorio. Se valida justo después del
     * chequeo de equipo (la precondición más barata primero) y antes de las
     * reglas de horómetro y actividades, así un operador inactivo o
     * inexistente falla rápido. `operador` (snapshot) se arma acá con el
     * nombre del catálogo: el cliente no lo manda.
     */
    const operator = await this.operators.assertActive(dto.operatorId);

    /**
     * Un equipo con turno en curso **sí** admite un trabajo extraordinario:
     * los trabajos se registran al final del turno y usan la misma máquina
     * durante sus tiempos en ralentí. Lo que importa es dejar registro de la
     * máquina que ejecutó la tarea, como respaldo del pago. Que el equipo esté
     * en turno es un aviso del formulario, no un bloqueo.
     */
    const datos = this.validar({
      equipoId: dto.equipoId,
      operatorId: operator.id,
      operador: operator.name,
      faena: dto.faena,
      turno: dto.turno,
      horometroInicial: dto.horometroInicial,
      horometroFinal: dto.horometroFinal,
      totalHoras: 0,
      actividades: dto.actividades,
      otraActividad: dto.otraActividad ?? null,
      descripcion: dto.descripcion,
      observaciones: dto.observaciones ?? null,
    });

    return this.prisma.trabajoExtraordinario.create({
      data: {
        ...(dto.id ? { id: dto.id } : {}),
        createdById: userId,
        fecha,
        ...datos,
      },
      include: TRABAJO_EXTRA_INCLUDE,
    });
  }

  findAll(): Promise<TrabajoExtraResponse[]> {
    return this.prisma.trabajoExtraordinario.findMany({
      orderBy: { fecha: 'desc' },
      include: TRABAJO_EXTRA_INCLUDE,
    });
  }

  async findOne(id: string): Promise<TrabajoExtraResponse> {
    const reg = await this.prisma.trabajoExtraordinario.findUnique({
      where: { id },
      include: TRABAJO_EXTRA_INCLUDE,
    });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }

  /**
   * Edita un trabajo ya registrado.
   *
   * No pide autorización, pero no es silencioso: lo que cambió queda en
   * `ChangeLog` —en la misma transacción que la edición, para que no exista
   * una sin la otra— y el administrador recibe un aviso con cada dato y su
   * antes y después. Si nada cambió de verdad, no se escribe ni se avisa.
   */
  async update(
    id: string,
    dto: UpdateTrabajoExtraDto,
    editor: Editor,
    expected?: ExpectedValues,
  ): Promise<TrabajoExtraResponse> {
    let equipoNuevo: { internalCode: string } | null = null;
    if (dto.equipoId) {
      equipoNuevo = await this.prisma.equipment.findUnique({
        where: { id: dto.equipoId },
        select: { internalCode: true },
      });
      if (!equipoNuevo) throw new NotFoundException('Equipo no encontrado');
    }

    // El operador se cambia por catálogo, igual que al crear: se valida que
    // esté activo y el snapshot `operador` se deriva de su nombre. Si no se
    // toca, se conserva lo guardado (incluidas las filas legacy sin
    // `operatorId`) sin exigir que el operador siga activo.
    const previo = await this.prisma.trabajoExtraordinario.findUnique({
      where: { id },
      select: { operatorId: true },
    });
    if (!previo) throw new NotFoundException('Registro no encontrado');
    let operadorValidado: { id: string; name: string } | null =
      dto.operatorId && dto.operatorId !== previo.operatorId
        ? await this.operators.assertActive(dto.operatorId)
        : null;

    const { registro, cambios, codigo } = await this.prisma.$transaction(
      async (tx) => {
        // Todo se calcula sobre la fila vigente, leída con el bloqueo tomado:
        // una edición ajena de OTRO campo, confirmada antes de este bloqueo,
        // no se revierte al escribir ni queda mal registrada en el historial.
        const montar = async (actual: DatosTrabajo): Promise<DatosTrabajo> => {
          let operador: { id: string; name: string } | null = null;
          if (dto.operatorId && dto.operatorId !== actual.operatorId) {
            // Un operador que cambió entre la validación y el bloqueo
            // (carrera improbable) se valida de nuevo en vez de guardarse sin
            // chequear.
            if (operadorValidado?.id !== dto.operatorId) {
              operadorValidado = await this.operators.assertActive(
                dto.operatorId,
              );
            }
            operador = operadorValidado;
          }
          return this.mezclar(actual, dto, operador);
        };

        const vigente = await assertExpectedLocked({
          tx,
          table: 'trabajoExtraordinario',
          id,
          expected,
          read: (t) =>
            t.trabajoExtraordinario.findUnique({
              where: { id },
              include: TRABAJO_EXTRA_INCLUDE,
            }),
          comparable: datosDe,
          desired: async (actual) => ({ ...(await montar(actual)) }),
          labels: CAMPO_LABEL,
          notFoundMessage: 'Registro no encontrado',
        });
        const nuevo = await montar(vigente);
        const codigoNuevo =
          equipoNuevo?.internalCode ?? vigente.equipo.internalCode;

        const codigos: Record<string, string> = {
          [vigente.equipoId]: vigente.equipo.internalCode,
          [nuevo.equipoId]: codigoNuevo,
        };
        const actividades = (v: unknown) =>
          (v as string[]).map((a) => ACTIVIDAD_LABEL[a] ?? a).join(', ');
        const CAMPOS: readonly ComparableField<DatosTrabajo>[] = [
          {
            field: 'equipoId',
            label: 'Equipo',
            format: (v) => codigos[v as string] ?? String(v),
          },
          { field: 'operador', label: 'Operador' },
          { field: 'faena', label: 'Faena' },
          { field: 'turno', label: 'Turno' },
          {
            field: 'horometroInicial',
            label: 'Horómetro inicial',
            format: horas,
          },
          { field: 'horometroFinal', label: 'Horómetro final', format: horas },
          { field: 'actividades', label: 'Actividades', format: actividades },
          { field: 'otraActividad', label: 'Otra actividad' },
          { field: 'descripcion', label: 'Descripción' },
          { field: 'observaciones', label: 'Observaciones' },
        ];
        const diff = diffFields<DatosTrabajo>(vigente, nuevo, CAMPOS);
        if (diff.length === 0) {
          return { registro: vigente, cambios: diff, codigo: codigoNuevo };
        }

        const editado = await tx.trabajoExtraordinario.update({
          where: { id },
          data: nuevo,
          include: TRABAJO_EXTRA_INCLUDE,
        });
        await this.changeLog.record(tx, 'trabajo_extra', id, editor, diff);
        return { registro: editado, cambios: diff, codigo: codigoNuevo };
      },
    );

    if (cambios.length > 0) {
      this.eventEmitter.emit(DOMAIN_EVENTS.RECORD_EDITED, {
        entity: 'trabajo_extra',
        entityId: id,
        entityArticle: 'el',
        entityLabel: `trabajo extra de ${codigo} del ${formatBusinessDate(registro.fecha)}`,
        editedBy: editor.name,
        changes: cambios.map(({ label, before, after }) => ({
          label,
          before,
          after,
        })),
      } satisfies RecordEditedEvent);
    }

    return registro;
  }

  /**
   * Lo que vino se monta sobre lo guardado y se valida el resultado: un body
   * con solo el horómetro final igual tiene que respetar el inicial.
   */
  private mezclar(
    actual: DatosTrabajo,
    dto: UpdateTrabajoExtraDto,
    operator: { id: string; name: string } | null,
  ): DatosTrabajo {
    return this.validar({
      equipoId: dto.equipoId ?? actual.equipoId,
      operatorId: operator?.id ?? actual.operatorId,
      operador: operator?.name ?? actual.operador,
      faena: dto.faena ?? actual.faena,
      turno: dto.turno ?? actual.turno,
      horometroInicial: dto.horometroInicial ?? actual.horometroInicial,
      horometroFinal: dto.horometroFinal ?? actual.horometroFinal,
      totalHoras: actual.totalHoras,
      actividades: dto.actividades ?? actual.actividades,
      otraActividad:
        dto.otraActividad !== undefined
          ? dto.otraActividad
          : actual.otraActividad,
      descripcion: dto.descripcion ?? actual.descripcion,
      observaciones:
        dto.observaciones !== undefined
          ? dto.observaciones
          : actual.observaciones,
    });
  }

  /** Los cambios de un trabajo, del más reciente al más viejo. */
  findChanges(id: string) {
    return this.changeLog.findFor('trabajo_extra', id);
  }

  /**
   * Reglas de un trabajo completo, al crearlo o después de editarlo, y el
   * total de horas recalculado. Devuelve los datos listos para guardar.
   */
  private validar(datos: DatosTrabajo): DatosTrabajo {
    /**
     * Un horómetro no retrocede: si el final es menor que el inicial, alguien
     * se equivocó al tipear.
     *
     * Se rechaza en vez de truncar a 0 horas: un cero inventado quedaría
     * invisible en la base, indistinguible de un trabajo legítimo que duró
     * cero, y estas horas respaldan un cobro.
     *
     * El formulario ya lo valida (`trabajoExtraFormSchema` tiene un `.refine()`),
     * pero eso no alcanza: Terreno funciona sin conexión y sincroniza después,
     * así que un registro encolado se reenvía sin pasar por el formulario.
     */
    if (datos.horometroFinal < datos.horometroInicial) {
      throw new BadRequestException(
        `El horómetro final (${formatNumber(datos.horometroFinal)}) no puede ser menor que el inicial (${formatNumber(datos.horometroInicial)}).`,
      );
    }

    /**
     * «Otro» sin texto no dice nada: la actividad quedaría registrada como
     * «otro» a secas y el trabajo no se podría justificar ni cobrar. Si se
     * eligió, el texto es obligatorio; si no se eligió, se descarta para que
     * no quede un texto huérfano contradiciendo la lista.
     */
    const eligioOtro = datos.actividades.includes('OTRO');
    const otraActividad = datos.otraActividad?.trim();
    if (eligioOtro && !otraActividad) {
      throw new BadRequestException(
        'Elegiste «Otro» como actividad: describí cuál fue.',
      );
    }

    return {
      ...datos,
      otraActividad: eligioOtro ? (otraActividad ?? null) : null,
      observaciones: datos.observaciones?.trim() || null,
      totalHoras: Number(
        (datos.horometroFinal - datos.horometroInicial).toFixed(2),
      ),
    };
  }
}
