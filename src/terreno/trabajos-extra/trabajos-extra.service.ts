import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { TrabajoExtraordinario } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { OperatorsService } from '../../operators/operators.service';
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

const horas = (v: unknown) =>
  `${Number(v).toLocaleString('es-CL', { maximumFractionDigits: 2 })} h`;

@Injectable()
export class TrabajosExtraService {
  constructor(
    private prisma: PrismaService,
    private readonly operators: OperatorsService,
    private eventEmitter: EventEmitter2,
    private changeLog: ChangeLogService,
  ) {}

  async create(dto: CreateTrabajoExtraDto) {
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

    return this.prisma.trabajoExtraordinario.create({
      data: this.validar({
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
      }),
    });
  }

  findAll() {
    return this.prisma.trabajoExtraordinario.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { internalCode: true } } },
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.trabajoExtraordinario.findUnique({
      where: { id },
    });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }

  /**
   * Edita un trabajo ya registrado (Acta N.° 004, R13).
   *
   * No pide autorización, pero no es silencioso: lo que cambió queda en
   * `ChangeLog` —en la misma transacción que la edición, para que no exista
   * una sin la otra— y el administrador recibe un aviso con cada dato y su
   * antes y después. Si nada cambió de verdad, no se escribe ni se avisa.
   */
  async update(id: string, dto: UpdateTrabajoExtraDto, editor: Editor) {
    const actual = await this.prisma.trabajoExtraordinario.findUnique({
      where: { id },
      include: { equipo: { select: { internalCode: true } } },
    });
    if (!actual) throw new NotFoundException('Registro no encontrado');

    let codigoNuevo = actual.equipo.internalCode;
    if (dto.equipoId && dto.equipoId !== actual.equipoId) {
      const equipo = await this.prisma.equipment.findUnique({
        where: { id: dto.equipoId },
      });
      if (!equipo) throw new NotFoundException('Equipo no encontrado');
      codigoNuevo = equipo.internalCode;
    }

    // El operador se cambia por catálogo, igual que al crear: se valida que
    // esté activo y el snapshot `operador` se deriva de su nombre. Si no se
    // toca, se conserva lo guardado (incluidas las filas legacy sin
    // `operatorId`) sin exigir que el operador siga activo.
    let operatorId = actual.operatorId;
    let operador = actual.operador;
    if (dto.operatorId && dto.operatorId !== actual.operatorId) {
      const operator = await this.operators.assertActive(dto.operatorId);
      operatorId = operator.id;
      operador = operator.name;
    }

    // Lo que vino se monta sobre lo guardado y se valida el resultado: un
    // body con solo el horómetro final igual tiene que respetar el inicial.
    const nuevo = this.validar({
      equipoId: dto.equipoId ?? actual.equipoId,
      operatorId,
      operador,
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

    const codigos: Record<string, string> = {
      [actual.equipoId]: actual.equipo.internalCode,
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
      { field: 'horometroInicial', label: 'Horómetro inicial', format: horas },
      { field: 'horometroFinal', label: 'Horómetro final', format: horas },
      { field: 'actividades', label: 'Actividades', format: actividades },
      { field: 'otraActividad', label: 'Otra actividad' },
      { field: 'descripcion', label: 'Descripción' },
      { field: 'observaciones', label: 'Observaciones' },
    ];
    const cambios = diffFields<DatosTrabajo>(actual, nuevo, CAMPOS);
    if (cambios.length === 0) return actual;

    const editado = await this.prisma.$transaction(async (tx) => {
      const reg = await tx.trabajoExtraordinario.update({
        where: { id },
        data: nuevo,
        include: { equipo: { select: { internalCode: true } } },
      });
      await this.changeLog.record(tx, 'trabajo_extra', id, editor, cambios);
      return reg;
    });

    this.eventEmitter.emit(DOMAIN_EVENTS.RECORD_EDITED, {
      entity: 'trabajo_extra',
      entityId: id,
      entityLabel: `trabajo extra de ${codigoNuevo} del ${actual.fecha.toLocaleDateString('es-CL')}`,
      editedBy: editor.name,
      changes: cambios.map(({ label, before, after }) => ({
        label,
        before,
        after,
      })),
    } satisfies RecordEditedEvent);

    return editado;
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
     * Antes esto era `Math.max(0, final - inicial)`, que guardaba **0 horas en
     * silencio** y dejaba el error invisible en la base — indistinguible de un
     * trabajo legítimo que duró cero. Y como estas horas respaldan un cobro,
     * un cero inventado es peor que un rechazo.
     *
     * El formulario ya lo valida (`trabajoExtraFormSchema` tiene un `.refine()`),
     * pero eso no alcanza: la especificación pide que Terreno funcione sin
     * conexión y sincronice después (R4), así que un registro encolado se
     * reenvía sin pasar por el formulario.
     */
    if (datos.horometroFinal < datos.horometroInicial) {
      throw new BadRequestException(
        `El horómetro final (${datos.horometroFinal}) no puede ser menor que el inicial (${datos.horometroInicial}).`,
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
