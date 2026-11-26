import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { TrabajoExtraordinario } from '@prisma/client';

import { ROLES, sessionHasRole } from '../../auth/roles';
import { assertExpectedLocked } from '../../common/concurrency/assert-expected-locked';
import { type ExpectedValues } from '../../common/concurrency/expected-fields';
import {
  createOrReturn,
  isUniqueViolationOn,
} from '../../common/idempotency/create-or-return';
import { ERROR_CODES } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { formatNumber } from '../../common/format/number';
import { OperatorsService } from '../../operators/operators.service';
import { resolveNombresUsuarios } from '../common/registrado-por.util';
import { resolveRecordDate } from '../../common/dates/capture-time';
import {
  businessDayInstant,
  formatBusinessDate,
  formatBusinessDateTime,
} from '../../common/dates/business-time';
import {
  SHIFT_DATE_MAX_FUTURE_DAYS,
  assertOldRecordDateWithinWindow,
  isDateOnlyString,
} from '../../shifts/date-only';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import type { RecordEditedEvent } from '../../common/events/domain-events';
import {
  ChangeLogService,
  diffFields,
  type ComparableField,
  type Editor,
} from '../../change-log/change-log.service';
import { StorageService } from '../../storage/storage.service';
import {
  ACTIVIDAD_LABEL,
  DESTINO_LABEL,
  ActividadDetalleDto,
  CreateTrabajoExtraDto,
  NULO_SIN_TRABAJO,
} from './dto/create-trabajo-extra.dto';
import { UpdateTrabajoExtraDto } from './dto/update-trabajo-extra.dto';
import { normalizarFolio } from './folio';

/** Lo que responde `GET /trabajos-extra/folio-libre`. */
export interface FolioLibreResponse {
  /** El folio normalizado (sin ceros a la izquierda). */
  folio: string;
  libre: boolean;
  /** El Report que ya lo usa, si lo hay (`equipo` null: un report nulo sin
   * equipo). */
  ocupadoPor: {
    id: string;
    equipo: string | null;
    nulo: boolean;
    fecha: Date;
  } | null;
}

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

/**
 * El cliente omite `createdById` en TODAS las consultas (`PrismaService`,
 * para que nunca salga crudo en una respuesta). `registradoPor` se resuelve
 * desde ese id, así que las consultas que arman la respuesta lo piden explícito:
 * sin esto, «Registrado por» salía vacío siempre, también en los registros nuevos.
 */
const CON_DUENO = { createdById: false } as const;

/** Un trabajo tal como sale a la API: sin `createdById` crudo — en su lugar
 * va `registradoPor`, el nombre resuelto de quien lo registró (null si la
 * cuenta ya no existe) — y sin `fotoKey`: la foto del report sale solo como
 * `fotoUrl` firmada (mismo criterio que `HallazgoResponse`). */
export type TrabajoExtraResponse = Omit<
  Prisma.TrabajoExtraordinarioGetPayload<{
    include: typeof TRABAJO_EXTRA_INCLUDE;
  }>,
  'createdById' | 'fotoKey'
> & { registradoPor: string | null; fotoUrl: string | null };

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
  | 'reportNumero'
>;

/** Una fila del desglose por actividad, como se guarda en
 * `detalle_actividades` (y como la expone la API en `detalle`). */
export interface DetalleActividad {
  actividad: string;
  lugar: string;
  /** Las plantas unidas por «, » (`PP1, PP4`): lo que leen el registro de
   * cambios, el Excel y las versiones anteriores de la app. */
  planta: string | null;
  /** Las plantas por separado — ausente en filas anteriores (13-11), que
   * tenían una sola en `planta`. */
  plantas?: string[];
  horas: number;
  /** Qué se hizo en esta actividad — `null` si no se escribió; ausente en
   * filas anteriores al campo (13-11). */
  descripcion?: string | null;
}

/**
 * Reglas POR FILA del desglose (cliente, 05-11 y 13-11) + normalización:
 * - `lugar` es el TIPO de tarea, que define cómo se paga;
 * - una limpieza de silos es SIEMPRE de tipo Planta y es la única que lo es:
 *   el servidor fija PLANTA aunque llegue otro tipo (había limpiezas de silos
 *   marcadas como Transporte) y rechaza PLANTA en cualquier otra actividad;
 * - si llega PLANTA, dice en cuál; en el resto la planta se descarta para que
 *   no quede un nombre huérfano.
 */
function normalizarDetalle(filas: ActividadDetalleDto[]): DetalleActividad[] {
  return filas.map((f) => {
    // Varias plantas (`plantas`) o, de una versión anterior, una sola (`planta`).
    const nombres = [
      ...new Set(
        (f.plantas ?? (f.planta != null ? [f.planta] : []))
          .map((p) => p.trim())
          .filter((p) => p !== ''),
      ),
    ];
    const esSilos = f.actividad === 'LIMPIEZA_SILOS';
    if (f.lugar === 'PLANTA') {
      if (!esSilos) {
        throw new BadRequestException(
          'Solo una limpieza de silos es de tipo Planta: para el resto usá Transporte o Variado.',
        );
      }
      if (nombres.length === 0) {
        throw new BadRequestException(
          'Indicá en qué planta se hizo la limpieza de silos.',
        );
      }
    }
    // Un cliente anterior pudo mandar la limpieza de silos como otro tipo y
    // sin planta: se corrige el tipo y la planta queda sin dato.
    const lugar = esSilos ? 'PLANTA' : f.lugar;
    const plantas = lugar === 'PLANTA' ? nombres : [];
    return {
      actividad: f.actividad,
      lugar,
      planta: plantas.length > 0 ? plantas.join(', ') : null,
      plantas,
      horas: Number(f.horas.toFixed(2)),
      descripcion: f.descripcion?.trim() || null,
    };
  });
}

/** El resumen `actividades` (String[]) se deriva del desglose — filtros,
 * avisos y filas legacy siguen leyendo de ahí. */
const actividadesDe = (detalle: DetalleActividad[]): string[] => [
  ...new Set(detalle.map((d) => d.actividad)),
];

/** `Limpieza de silos · Planta (P.P.1) · 3 h; …` — cómo se lee el desglose
 * en el registro de cambios. Una fila legacy sin desglose cae al resumen. */
function resumenDetalle(detalle: unknown, actividades: string[]): string {
  const filas = Array.isArray(detalle) ? (detalle as DetalleActividad[]) : null;
  if (!filas?.length) {
    return actividades.map((a) => ACTIVIDAD_LABEL[a] ?? a).join(', ');
  }
  return filas
    .map(
      (d) =>
        `${ACTIVIDAD_LABEL[d.actividad] ?? d.actividad} · ${DESTINO_LABEL[d.lugar] ?? d.lugar}${
          d.planta ? ` (${d.planta})` : ''
        } · ${formatNumber(d.horas)} h${d.descripcion ? ` · ${d.descripcion}` : ''}`,
    )
    .join('; ');
}

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
  reportNumero: 'N° de report',
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
    reportNumero: t.reportNumero,
  };
}

const horas = (v: unknown) => `${formatNumber(Number(v))} h`;

/** Lo que la edición de un report NULO no acepta: no hubo trabajo. */
const CAMPOS_DE_TRABAJO_EDICION = [
  'horometroInicial',
  'horometroFinal',
  'actividades',
  'detalle',
  'otraActividad',
] as const;

/** Quién corrige un report nulo (decisión del cliente, 26-11). */
const ROLES_EDITAN_NULO = [ROLES.ADMIN, ROLES.SECRETARIA] as const;

/** Cómo se nombra, en el 409, el Report que ya tiene el folio. */
function quienTieneElFolio(ocupado: {
  nulo: boolean;
  fecha: Date;
  equipo: { internalCode: string } | null;
}): string {
  const codigo = ocupado.equipo?.internalCode;
  const quien = ocupado.nulo
    ? `report nulo${codigo ? ` de ${codigo}` : ''}`
    : `equipo ${codigo ?? '—'}`;
  return `${quien}, fecha ${formatBusinessDate(ocupado.fecha)}`;
}

@Injectable()
export class TrabajosExtraService {
  constructor(
    private prisma: PrismaService,
    private readonly operators: OperatorsService,
    private eventEmitter: EventEmitter2,
    private changeLog: ChangeLogService,
    private readonly storage: StorageService,
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

  /**
   * `fecha` date-only = carga histórica de Terreno («subir reportes
   * antiguos»): hasta un año atrás —un Report no mueve contadores ni
   * turnos— y el instante se guarda DENTRO de ese día de negocio (por donde agrupan
   * el dashboard y los filtros del admin) — por `resolveRecordDate` un
   * date-only caería a medianoche UTC, el día ANTERIOR en Chile. Con hora
   * (panel del admin) o sin `fecha`, la ruta de siempre.
   */
  private resolverFecha(fecha?: string, capturedAt?: string): Date {
    if (fecha && isDateOnlyString(fecha)) {
      assertOldRecordDateWithinWindow(fecha, {
        maxFutureDays: SHIFT_DATE_MAX_FUTURE_DAYS,
      });
      return businessDayInstant(fecha);
    }
    return resolveRecordDate(fecha, capturedAt);
  }

  private async createFresh(dto: CreateTrabajoExtraDto, userId: string) {
    const fecha = this.resolverFecha(dto.fecha, dto.capturedAt);
    if (dto.nulo === true) return this.createNulo(dto, userId, fecha);

    // Un Report normal trae todo esto: el DTO lo exige salvo en un nulo.
    const equipoId = dto.equipoId!;
    const equipo = await this.prisma.equipment.findUnique({
      where: { id: equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    /**
     * Operador del catálogo — obligatorio. Se valida justo después del
     * chequeo de equipo (la precondición más barata primero) y antes de las
     * reglas de horómetro y actividades, así un operador inactivo o
     * inexistente falla rápido. `operador` (snapshot) se arma acá con el
     * nombre del catálogo: el cliente no lo manda.
     */
    const operator = await this.operators.assertActive(dto.operatorId!);

    /**
     * Un equipo con turno en curso **sí** admite un trabajo extraordinario:
     * los trabajos se registran al final del turno y usan la misma máquina
     * durante sus tiempos en ralentí. Lo que importa es dejar registro de la
     * máquina que ejecutó la tarea, como respaldo del pago. Que el equipo esté
     * en turno es un aviso del formulario, no un bloqueo.
     */
    // El desglose por actividad valida sus reglas por fila y de él se deriva
    // el resumen `actividades` (el cliente ya no manda la lista suelta).
    const detalle = normalizarDetalle(dto.detalle!);
    const datos = this.validar({
      equipoId,
      operatorId: operator.id,
      operador: operator.name,
      faena: dto.faena,
      turno: dto.turno,
      horometroInicial: dto.horometroInicial!,
      horometroFinal: dto.horometroFinal!,
      totalHoras: 0,
      actividades: actividadesDe(detalle),
      otraActividad: dto.otraActividad ?? null,
      descripcion: dto.descripcion!,
      observaciones: dto.observaciones ?? null,
      reportNumero: normalizarFolio(dto.reportNumero),
    });
    return this.insertar(dto, userId, fecha, datos, detalle);
  }

  /**
   * Report NULO: el papel se anuló y se registra solo para que el folio no
   * deje un hueco. N°, fecha y foto como cualquier Report; equipo, operador
   * y motivo si vienen. 0 h, sin desglose y con los horómetros en 0: nunca
   * suma horas, cobro, HM ni asistencia, y no toca ningún contador.
   */
  private async createNulo(
    dto: CreateTrabajoExtraDto,
    userId: string,
    fecha: Date,
  ) {
    // El DTO ya lo rechaza; se repite por si el servicio se llama sin el pipe.
    if (
      dto.horometroInicial !== undefined ||
      dto.horometroFinal !== undefined ||
      dto.detalle !== undefined ||
      dto.otraActividad !== undefined
    ) {
      throw new BadRequestException(NULO_SIN_TRABAJO);
    }
    const equipoId = dto.equipoId?.trim() || null;
    if (equipoId) {
      const equipo = await this.prisma.equipment.findUnique({
        where: { id: equipoId },
        select: { id: true },
      });
      if (!equipo) throw new NotFoundException('Equipo no encontrado');
    }
    const operatorId = dto.operatorId?.trim() || null;
    const operator = operatorId
      ? await this.operators.assertActive(operatorId)
      : null;
    const datos = this.validar({
      equipoId,
      operatorId: operator?.id ?? null,
      operador: operator?.name ?? null,
      faena: dto.faena,
      turno: dto.turno,
      horometroInicial: 0,
      horometroFinal: 0,
      totalHoras: 0,
      actividades: [],
      otraActividad: null,
      descripcion: dto.descripcion?.trim() ?? '',
      observaciones: dto.observaciones ?? null,
      reportNumero: normalizarFolio(dto.reportNumero),
    });
    return this.insertar(dto, userId, fecha, { ...datos, nulo: true }, null);
  }

  /** Folio libre → foto reclamada → insert (común al normal y al nulo). */
  private async insertar(
    dto: CreateTrabajoExtraDto,
    userId: string,
    fecha: Date,
    datos: DatosTrabajo & { nulo?: boolean },
    detalle: DetalleActividad[] | null,
  ) {
    // El folio es EL número del Report: uno ya usado se rechaza antes de
    // reclamar la foto. Un reintento del MISMO registro no llega acá
    // (`createOrReturn` lo devuelve por su id).
    const folio = datos.reportNumero!;
    await this.assertFolioLibre(folio);

    // La foto del report se reclama DESPUÉS de validar: una key tmp reclamada
    // por un create que luego rebota quedaría huérfana en el bucket.
    const fotoKey = dto.fotoKey
      ? await this.storage.claimTmp(dto.fotoKey, userId, 'trabajo-extra-photo')
      : null;

    let creado;
    try {
      creado = await this.prisma.trabajoExtraordinario.create({
        data: {
          ...(dto.id ? { id: dto.id } : {}),
          createdById: userId,
          fecha,
          fotoKey,
          ...(detalle
            ? {
                detalleActividades: detalle as unknown as Prisma.InputJsonValue,
              }
            : {}),
          ...datos,
        },
        include: TRABAJO_EXTRA_INCLUDE,
        omit: CON_DUENO,
      });
    } catch (error: unknown) {
      // La foto reclamada tiene una key propia de este intento: si el insert
      // no entró (folio tomado entre medio, carrera por id), se suelta.
      if (fotoKey) await this.storage.deleteBestEffort(fotoKey);
      return this.folioDuplicado(error, folio);
    }
    const nombres = await resolveNombresUsuarios(this.prisma, [userId]);
    return this.shape(creado, nombres);
  }

  async findAll(): Promise<TrabajoExtraResponse[]> {
    const registros = await this.prisma.trabajoExtraordinario.findMany({
      orderBy: { fecha: 'desc' },
      include: TRABAJO_EXTRA_INCLUDE,
      omit: CON_DUENO,
    });
    const nombres = await resolveNombresUsuarios(
      this.prisma,
      registros.map((r) => r.createdById),
    );
    return Promise.all(registros.map((r) => this.shape(r, nombres)));
  }

  async findOne(id: string): Promise<TrabajoExtraResponse> {
    const reg = await this.prisma.trabajoExtraordinario.findUnique({
      where: { id },
      include: TRABAJO_EXTRA_INCLUDE,
      omit: CON_DUENO,
    });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    const nombres = await resolveNombresUsuarios(this.prisma, [
      reg.createdById,
    ]);
    return this.shape(reg, nombres);
  }

  /**
   * `GET /trabajos-extra/folio-libre?folio=&exceptoId=`: si el folio está
   * libre, para que el formulario lo avise antes de enviar (sin señal revisa
   * la lista guardada). `exceptoId`: al corregir, el Report propio no cuenta.
   */
  async folioLibre(
    folio: string,
    exceptoId?: string,
  ): Promise<FolioLibreResponse> {
    const normalizado = normalizarFolio(folio);
    const ocupado = await this.buscarFolio(normalizado, exceptoId);
    return {
      folio: normalizado,
      libre: ocupado == null,
      ocupadoPor: ocupado
        ? {
            id: ocupado.id,
            equipo: ocupado.equipo?.internalCode ?? null,
            nulo: ocupado.nulo,
            fecha: ocupado.fecha,
          }
        : null,
    };
  }

  private buscarFolio(
    folio: string,
    exceptoId?: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    return tx.trabajoExtraordinario.findFirst({
      where: {
        reportNumero: folio,
        ...(exceptoId ? { id: { not: exceptoId } } : {}),
      },
      select: {
        id: true,
        fecha: true,
        nulo: true,
        equipo: { select: { internalCode: true } },
      },
    });
  }

  /** 409 `FOLIO_EN_USO` si otro Report ya tiene el folio. */
  private async assertFolioLibre(
    folio: string,
    exceptoId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const ocupado = await this.buscarFolio(folio, exceptoId, tx);
    if (ocupado) {
      throw new ConflictException({
        message: `El N° de report ${folio} ya está registrado (${quienTieneElFolio(ocupado)}).`,
        code: ERROR_CODES.FOLIO_EN_USO,
      });
    }
  }

  /**
   * Dos envíos con el mismo folio a la vez: el índice único deja pasar uno y
   * el otro choca (P2002). Se traduce al mismo 409 legible que el chequeo
   * previo; cualquier otro error sigue su camino.
   */
  private async folioDuplicado(
    error: unknown,
    folio: string,
    exceptoId?: string,
  ): Promise<never> {
    if (isUniqueViolationOn(error, 'report_numero', 'reportNumero')) {
      await this.assertFolioLibre(folio, exceptoId);
      throw new ConflictException({
        message: `El N° de report ${folio} ya está registrado.`,
        code: ERROR_CODES.FOLIO_EN_USO,
      });
    }
    throw error;
  }

  /** Corre `fn` traduciendo el choque del índice único del folio (si se está
   * cambiando) al 409 legible. */
  private async conFolioUnico<T>(
    folio: string | undefined,
    exceptoId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (folio) return this.folioDuplicado(error, folio, exceptoId);
      throw error;
    }
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
    /** Rol de la sesión: un report nulo lo corrigen solo ADMIN/SECRETARIA.
     * Sin rol (llamada interna) no se restringe. */
    rol?: string | string[],
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
      select: { operatorId: true, nulo: true },
    });
    if (!previo) throw new NotFoundException('Registro no encontrado');
    // Un report NULO solo corrige N°, fecha, motivo, equipo y operador (y
    // faena/turno); no hay paso de nulo a normal. La fecha, al revés, solo se
    // corrige en un nulo: en un Report normal es parte de la trazabilidad.
    if (previo.nulo) {
      if (
        rol !== undefined &&
        !ROLES_EDITAN_NULO.some((r) => sessionHasRole(rol, r))
      ) {
        throw new ForbiddenException(
          'Un report nulo lo corrige un administrador o la secretaria.',
        );
      }
      if (CAMPOS_DE_TRABAJO_EDICION.some((c) => dto[c] !== undefined)) {
        throw new BadRequestException(NULO_SIN_TRABAJO);
      }
    } else if (dto.fecha !== undefined) {
      throw new BadRequestException(
        'La fecha solo se corrige en un report nulo.',
      );
    }
    const fechaNueva =
      dto.fecha !== undefined ? this.resolverFecha(dto.fecha) : undefined;
    // El folio corregido se normaliza antes de montarlo sobre lo guardado: así
    // «04615» contra un «4615» vigente no cuenta como cambio.
    const folioNuevo =
      dto.reportNumero !== undefined
        ? normalizarFolio(dto.reportNumero)
        : undefined;
    if (folioNuevo !== undefined) dto = { ...dto, reportNumero: folioNuevo };
    let operadorValidado: { id: string; name: string } | null =
      dto.operatorId && dto.operatorId !== previo.operatorId
        ? await this.operators.assertActive(dto.operatorId)
        : null;

    const { registro, cambios, codigo } = await this.conFolioUnico(
      folioNuevo,
      id,
      () =>
        this.prisma.$transaction(async (tx) => {
          // Todo se calcula sobre la fila vigente, leída con el bloqueo tomado:
          // una edición ajena de OTRO campo, confirmada antes de este bloqueo,
          // no se revierte al escribir ni queda mal registrada en el historial.
          const montar = async (
            actual: DatosTrabajo,
          ): Promise<DatosTrabajo> => {
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
                omit: CON_DUENO,
              }),
            comparable: datosDe,
            desired: async (actual) => ({ ...(await montar(actual)) }),
            labels: CAMPO_LABEL,
            notFoundMessage: 'Registro no encontrado',
          });
          const nuevo = await montar(vigente);
          if (
            nuevo.reportNumero &&
            nuevo.reportNumero !== vigente.reportNumero
          ) {
            await this.assertFolioLibre(nuevo.reportNumero, id, tx);
          }
          const codigoNuevo =
            equipoNuevo?.internalCode ?? vigente.equipo?.internalCode ?? null;

          const codigos: Record<string, string> = {};
          if (vigente.equipoId && vigente.equipo) {
            codigos[vigente.equipoId] = vigente.equipo.internalCode;
          }
          if (nuevo.equipoId && codigoNuevo) {
            codigos[nuevo.equipoId] = codigoNuevo;
          }
          const CAMPOS: readonly ComparableField<DatosTrabajo>[] = [
            {
              field: 'equipoId',
              label: 'Equipo',
              format: (v) =>
                v == null ? 'Sin equipo' : (codigos[v as string] ?? String(v)),
            },
            { field: 'operador', label: 'Operador' },
            { field: 'faena', label: 'Faena' },
            { field: 'turno', label: 'Turno' },
            {
              field: 'horometroInicial',
              label: 'Horómetro inicial',
              format: horas,
            },
            {
              field: 'horometroFinal',
              label: 'Horómetro final',
              format: horas,
            },
            { field: 'otraActividad', label: 'Otra actividad' },
            { field: 'descripcion', label: 'Descripción' },
            { field: 'observaciones', label: 'Observaciones' },
            { field: 'reportNumero', label: 'N° de report' },
          ];
          const diff = diffFields<DatosTrabajo>(vigente, nuevo, CAMPOS);
          // La fecha (solo en un nulo): con hora si llegó con hora (panel).
          const cambiaFecha =
            fechaNueva !== undefined &&
            fechaNueva.getTime() !== vigente.fecha.getTime() &&
            (!isDateOnlyString(dto.fecha!) ||
              formatBusinessDate(fechaNueva) !==
                formatBusinessDate(vigente.fecha));
          if (cambiaFecha) {
            const formato = isDateOnlyString(dto.fecha!)
              ? formatBusinessDate
              : formatBusinessDateTime;
            diff.push({
              field: 'fecha',
              label: 'Fecha',
              before: formato(vigente.fecha),
              after: formato(fechaNueva),
            });
          }
          // El desglose por actividad es JSON: se compara por su resumen
          // legible en vez de entrar a los diffs escalares (cubre también el
          // resumen `actividades`, que se deriva de él).
          const detalleNuevo = dto.detalle
            ? normalizarDetalle(dto.detalle)
            : null;
          const resumenAntes = resumenDetalle(
            vigente.detalleActividades,
            vigente.actividades,
          );
          const resumenDespues = detalleNuevo
            ? resumenDetalle(detalleNuevo, nuevo.actividades)
            : resumenAntes;
          if (resumenAntes !== resumenDespues) {
            diff.push({
              field: 'detalle',
              label: 'Actividades',
              before: resumenAntes,
              after: resumenDespues,
            });
          }
          if (diff.length === 0) {
            return { registro: vigente, cambios: diff, codigo: codigoNuevo };
          }

          const editado = await tx.trabajoExtraordinario.update({
            where: { id },
            data: {
              ...nuevo,
              ...(cambiaFecha ? { fecha: fechaNueva } : {}),
              ...(detalleNuevo
                ? {
                    detalleActividades:
                      detalleNuevo as unknown as Prisma.InputJsonValue,
                  }
                : {}),
            },
            include: TRABAJO_EXTRA_INCLUDE,
            omit: CON_DUENO,
          });
          await this.changeLog.record(tx, 'trabajo_extra', id, editor, diff);
          return {
            registro: editado,
            cambios: diff,
            codigo: codigoNuevo,
          };
        }),
    );

    if (cambios.length > 0) {
      this.eventEmitter.emit(DOMAIN_EVENTS.RECORD_EDITED, {
        entity: 'trabajo_extra',
        entityId: id,
        entityArticle: 'el',
        entityLabel: registro.nulo
          ? `report nulo N° ${registro.reportNumero ?? '—'} del ${formatBusinessDate(registro.fecha)}`
          : `trabajo extra de ${codigo ?? '—'} del ${formatBusinessDate(registro.fecha)}`,
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

  /** Cambia el `createdById` crudo por `registradoPor` (el nombre resuelto) y
   * `fotoKey` por la URL firmada — la key del bucket nunca sale a la API. */
  private async shape<
    T extends { createdById: string | null; fotoKey: string | null },
  >(
    registro: T,
    nombres: Map<string, string>,
  ): Promise<
    Omit<T, 'createdById' | 'fotoKey'> & {
      registradoPor: string | null;
      fotoUrl: string | null;
    }
  > {
    const { createdById, fotoKey, ...resto } = registro;
    return {
      ...resto,
      registradoPor: (createdById && nombres.get(createdById)) || null,
      fotoUrl: fotoKey ? await this.storage.sign(fotoKey) : null,
    };
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
      actividades: dto.detalle
        ? actividadesDe(normalizarDetalle(dto.detalle))
        : (dto.actividades ?? actual.actividades),
      otraActividad:
        dto.otraActividad !== undefined
          ? dto.otraActividad
          : actual.otraActividad,
      descripcion: dto.descripcion ?? actual.descripcion,
      observaciones:
        dto.observaciones !== undefined
          ? dto.observaciones
          : actual.observaciones,
      reportNumero: dto.reportNumero ?? actual.reportNumero,
    });
  }

  /** Los cambios de un trabajo, del más reciente al más viejo. */
  findChanges(id: string) {
    return this.changeLog.findFor('trabajo_extra', id);
  }

  /**
   * Elimina un trabajo — solo el administrador (ver controller). La foto del
   * report se suelta best-effort DESPUÉS de borrar la fila (si el borrado
   * falla, la foto sigue donde debe); el historial de cambios (`ChangeLog`)
   * se conserva como traza. Mismo criterio que `HallazgosService.remove`.
   */
  async remove(id: string) {
    const registro = await this.prisma.trabajoExtraordinario.findUnique({
      where: { id },
      select: { fotoKey: true },
    });
    if (!registro) throw new NotFoundException('Registro no encontrado');

    await this.prisma.trabajoExtraordinario.delete({ where: { id } });

    if (registro.fotoKey) {
      await this.storage.deleteBestEffort(registro.fotoKey);
    }
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

    // Las reglas de dónde se hizo viven POR FILA en `normalizarDetalle`
    // (solo silos puede ser PLANTA, y con nombre de planta).

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
