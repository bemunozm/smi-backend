import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ROLES, sessionHasRole } from '../../auth/roles';
import {
  ChangeLogService,
  diffFields,
  type ComparableField,
} from '../../change-log/change-log.service';
import { toEditor } from '../../change-log/current-editor.decorator';
import { ERROR_CODES } from '../../common/errors/error-codes';
import {
  createOrReturn,
  isUniqueViolationOn,
} from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { businessDayInstant } from '../../common/dates/business-time';
import { formatNumber } from '../../common/format/number';
import {
  assertOldRecordDateWithinWindow,
  formatDateOnly,
  parseDateOnlyUtc,
} from '../../shifts/date-only';
import { ShiftsService } from '../../shifts/shifts.service';
import { StorageService } from '../../storage/storage.service';
import {
  CreateInformeTemporalDto,
  MAX_PERSONAL_POR_ACTIVIDAD,
  type PersonalInformeDto,
} from './dto/create-informe-temporal.dto';
import {
  CreateInformeAntiguoDto,
  type EquipoRegistradoDto,
} from './dto/create-informe-antiguo.dto';
import { QueryInformesTemporalesDto } from './dto/query-informes-temporales.dto';
import { UpdateInformeTemporalDto } from './dto/update-informe-temporal.dto';

/** Lo que se lee de cada informe para armar la respuesta. */
const INFORME_INCLUDE = {
  tarjetas: {
    orderBy: { fecha: 'asc' },
    select: {
      id: true,
      equipo: {
        select: {
          id: true,
          internalCode: true,
          type: true,
          brand: true,
          model: true,
        },
      },
      operador: true,
      valorInicial: true,
      valorFinal: true,
      fuelLiters: true,
      adBlueLiters: true,
      pumpPhotoKey: true,
      fecha: true,
      fechaSalida: true,
    },
  },
} satisfies Prisma.InformeTemporalInclude;

type InformeRecord = Prisma.InformeTemporalGetPayload<{
  include: typeof INFORME_INCLUDE;
}>;

export interface InformePersonal {
  actividad: 1 | 2;
  operatorId: string | null;
  nombre: string;
}

/** Una tarjeta cerrada con el informe. NUNCA expone la key cruda de la foto. */
export interface InformeTemporalTarjetaResponse {
  id: string;
  /** `name` = tipo, marca y modelo: el equipo no tiene un nombre propio. */
  equipo: { id: string; internalCode: string; name: string };
  operador: string;
  valorInicial: number;
  valorFinal: number | null;
  fuelLiters: number | null;
  adBlueLiters: number | null;
  /** URL FIRMADA (`StorageService.sign`); `null` si se cerró sin foto. */
  pumpPhotoUrl: string | null;
  fecha: Date;
  fechaSalida: Date | null;
}

/**
 * Un equipo de un informe subido después (`antiguo`), escrito a mano: así se
 * guarda en `equipos_registrados` y así sale a la API. `codigo`, `nombre` y
 * `unidad` son un snapshot del catálogo al subirlo.
 */
export interface EquipoRegistrado {
  equipoId: string;
  codigo: string;
  /** Tipo, marca y modelo (como `InformeTemporalTarjetaResponse.equipo.name`). */
  nombre: string;
  /** `km` en un liviano (camioneta), `h` en el resto. */
  unidad: 'h' | 'km';
  inicial: number;
  final: number;
  litros: number | null;
}

/** `SEM 02 4.713 → 4.720 h · 12 L; …` — cómo se leen en el historial. */
function resumenEquipos(equipos: EquipoRegistrado[]): string {
  if (equipos.length === 0) return '—';
  return equipos
    .map(
      (e) =>
        `${e.codigo} ${formatNumber(e.inicial)} → ${formatNumber(e.final)} ${e.unidad}${
          e.litros != null ? ` · ${formatNumber(e.litros)} L` : ''
        }`,
    )
    .join('; ');
}

/** Lo que responde `GET /informes-temporales/numero-libre`. */
export interface NumeroLibreResponse {
  numero: number;
  libre: boolean;
}

export interface InformeTemporalResponse {
  id: string;
  numero: number;
  /** Subido después: sin tarjetas, con `equiposRegistrados`. */
  antiguo: boolean;
  /** Los equipos escritos a mano de un informe `antiguo` (`[]` en uno normal). */
  equiposRegistrados: EquipoRegistrado[];
  /** `YYYY-MM-DD`, mismo criterio que `Shift.date` en la API. */
  fecha: string;
  turno: string;
  actividad1: string;
  actividad2: string | null;
  personal: InformePersonal[];
  observaciones: string | null;
  supervisorResponsable1: string;
  supervisorResponsable2: string | null;
  supervisorId: string;
  supervisorNombre: string;
  inicio: Date;
  fin: Date;
  /** Foto del report en papel: URL FIRMADA (`StorageService.sign`), `null`
   * si no tiene. La key cruda del bucket nunca sale a la API. */
  fotoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  tarjetas: InformeTemporalTarjetaResponse[];
}

/** Los campos editables del informe, con la fecha como `YYYY-MM-DD`. */
interface DatosInforme {
  fecha: string;
  turno: string;
  actividad1: string;
  actividad2: string | null;
  personal: InformePersonal[];
  observaciones: string | null;
  supervisorResponsable1: string;
  supervisorResponsable2: string | null;
}

/** Qué se compara y cómo se lee en el historial. */
const CAMPOS_INFORME: readonly ComparableField<DatosInforme>[] = [
  { field: 'fecha', label: 'Fecha' },
  { field: 'turno', label: 'Turno' },
  { field: 'actividad1', label: 'Actividad 1' },
  { field: 'actividad2', label: 'Actividad 2' },
  {
    field: 'personal',
    label: 'Personal',
    format: (v) => {
      const lista = v as InformePersonal[];
      return lista.length === 0
        ? '—'
        : lista.map((p) => `${p.nombre} (act. ${p.actividad})`).join(', ');
    },
  },
  { field: 'observaciones', label: 'Observaciones' },
  { field: 'supervisorResponsable1', label: 'Supervisor responsable 1' },
  { field: 'supervisorResponsable2', label: 'Supervisor responsable 2' },
];

/** ADMIN o SECRETARIA: la oficina, que ve y corrige todos los informes. */
function esStaff(session: UserSession): boolean {
  return (
    sessionHasRole(session.user.role, ROLES.ADMIN) ||
    sessionHasRole(session.user.role, ROLES.SECRETARIA)
  );
}

/** `equipos_registrados` tal como se guardó; `[]` si es null (informe normal). */
function equiposDe(valor: Prisma.JsonValue | null): EquipoRegistrado[] {
  return Array.isArray(valor) ? (valor as unknown as EquipoRegistrado[]) : [];
}

/** `YYYY-MM-DD` → `DD-MM-YYYY`. */
const fechaLegible = (dia: string) => dia.split('-').reverse().join('-');

/**
 * Informes del supervisor temporal: su jornada no tiene `Shift` ni reporte de
 * salida; la cierra con UN informe que cierra a la vez todas sus tarjetas
 * abiertas (`ShiftsService.closeCard(..., { viaInforme: true })`).
 */
@Injectable()
export class InformesTemporalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shifts: ShiftsService,
    private readonly storage: StorageService,
    private readonly changeLog: ChangeLogService,
  ) {}

  /**
   * `POST /api/informes-temporales`. Idempotente por `dto.id` (cola offline):
   * un reintento propio devuelve el informe ya creado sin volver a cerrar
   * nada; un id ajeno es 409 `ID_CONFLICT`.
   *
   * El lote tiene que ser EXACTAMENTE las tarjetas pendientes del supervisor:
   * si el cliente se quedó con una lista vieja (abrió otra en otro
   * dispositivo, el admin eliminó una), cerrar solo una parte dejaría
   * tarjetas sueltas que ya no se pueden cerrar por otra vía. «Pendiente»
   * incluye la tarjeta YA cerrada con un `closeClientId` de este lote: es la
   * que quedó cerrada en un intento cortado a la mitad (sin informe), y el
   * reintento tiene que poder completarlo. Las ya cerradas por él sin informe
   * (resto de un lote fallido) se enlazan aunque el cliente ya no las mande.
   *
   * Los cierres van uno por uno, FUERA de una transacción común: cada
   * `closeCard` tiene su propia tx (foto, combustible, AdBlue) y es
   * idempotente por `closeClientId`, así que un corte a la mitad se repara
   * reenviando el mismo lote. El informe y el enlace de las tarjetas sí van
   * juntos, al final, en una tx.
   */
  async create(
    dto: CreateInformeTemporalDto,
    session: UserSession,
  ): Promise<InformeTemporalResponse> {
    const userId = session.user.id;
    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe un informe con ese id.',
      findExisting: async (id) => {
        const existing = await this.findRecord(id);
        return existing
          ? {
              ownerId: existing.supervisorId,
              result: () => this.shape(existing),
            }
          : null;
      },
      create: () => this.createNuevo(dto, session),
    });
  }

  private async createNuevo(
    dto: CreateInformeTemporalDto,
    session: UserSession,
  ): Promise<InformeTemporalResponse> {
    const userId = session.user.id;
    const personal = this.validarPersonal(dto);

    const cardIds = dto.cierres.map((c) => c.cardId);
    if (new Set(cardIds).size !== cardIds.length) {
      throw new BadRequestException(
        'Una tarjeta viene dos veces en el informe.',
      );
    }

    // Pendientes del supervisor sin informe: las abiertas, las ya cerradas
    // con un `closeClientId` de este lote (intento cortado a la mitad) y las
    // que él mismo cerró sin que llegara a crearse su informe. Esas últimas
    // solo pueden ser restos de un lote fallido —el dueño cierra una temporal
    // únicamente vía informe—: un lote online donde la tarjeta 1 se cerró y
    // la 2 falló, el cliente descartó la operación, refrescó sus tarjetas (la
    // 1 ya no aparece, está cerrada) y reenvió solo la 2. Se enlazan a ESTE
    // informe aunque no vengan en `cierres`: si no, quedarían cerradas,
    // temporales y sin informe para siempre (fuera del reporte, del Excel y
    // del borrado).
    const pendientes = await this.prisma.registroHorometro.findMany({
      where: {
        supervisorId: userId,
        temporal: true,
        informeTemporalId: null,
        OR: [
          { valorFinal: null },
          { closeClientId: { in: dto.cierres.map((c) => c.closeClientId) } },
          { valorFinal: { not: null }, closedById: userId },
        ],
      },
      select: {
        id: true,
        fecha: true,
        valorFinal: true,
        closeClientId: true,
        equipo: { select: { internalCode: true } },
      },
    });
    await this.assertLoteCuadra(pendientes, cardIds, userId);

    const porId = new Map(pendientes.map((card) => [card.id, card]));
    for (const { cardId, ...cierre } of dto.cierres) {
      const card = porId.get(cardId);
      // Ya cerrada con OTRO `closeClientId` (resto de un lote fallido que el
      // cliente reenvía con un cierre nuevo): no se vuelve a cerrar, solo se
      // enlaza. Con el mismo, `closeCard` la devuelve tal cual (idempotente).
      if (
        card?.valorFinal != null &&
        card.closeClientId !== cierre.closeClientId
      ) {
        continue;
      }
      await this.shifts.closeCard(cardId, cierre, session, {
        viaInforme: true,
      });
    }

    const enlazar = pendientes.map((card) => card.id);
    const inicio = new Date(
      Math.min(...pendientes.map((card) => card.fecha.getTime())),
    );
    await this.conNumeroAutomatico((tx, numero) =>
      this.guardarNuevo(tx, numero, dto, session, personal, enlazar, inicio),
    );

    const creado = await this.findRecord(dto.id);
    // Recién creado en la tx de arriba: solo falta si alguien lo borró entre
    // medio, y entonces no hay nada que devolver.
    if (!creado) throw new ConflictException('El informe ya no existe.');
    return this.shape(creado);
  }

  /**
   * Corre la tx del informe normal con el siguiente N° LIBRE: un informe
   * subido después pudo tomar el que tocaba (`siguienteNumero` se lo salta),
   * y si uno se lo lleva justo entre medio (P2002 sobre `numero`) se reintenta
   * con el que sigue.
   */
  private async conNumeroAutomatico(
    fn: (tx: Prisma.TransactionClient, numero: number) => Promise<void>,
  ): Promise<void> {
    for (let intento = 1; ; intento++) {
      try {
        await this.prisma.$transaction(async (tx) =>
          fn(tx, await this.siguienteNumero(tx)),
        );
        return;
      } catch (error) {
        if (intento < 3 && isUniqueViolationOn(error, 'numero')) continue;
        throw error;
      }
    }
  }

  /** El próximo valor de la secuencia que ningún informe tenga tomado. */
  private async siguienteNumero(tx: Prisma.TransactionClient): Promise<number> {
    for (;;) {
      const [{ numero }] = await tx.$queryRaw<{ numero: number }[]>`
        SELECT nextval(pg_get_serial_sequence('informe_temporal', 'numero'))::int AS numero`;
      // ¿Ya lo tomó un informe subido después (N° del papel)?
      const tomados = await tx.informeTemporal.count({ where: { numero } });
      if (tomados === 0) return numero;
    }
  }

  /** El informe normal y el enlace de sus tarjetas, en la tx de `conNumeroAutomatico`. */
  private async guardarNuevo(
    tx: Prisma.TransactionClient,
    numero: number,
    dto: CreateInformeTemporalDto,
    session: UserSession,
    personal: InformePersonal[],
    enlazar: string[],
    inicio: Date,
  ): Promise<void> {
    const userId = session.user.id;
    await tx.informeTemporal.create({
      data: {
        id: dto.id,
        numero,
        fecha: parseDateOnlyUtc(dto.fecha),
        turno: dto.turno,
        actividad1: dto.actividad1.trim(),
        actividad2: dto.actividad2?.trim() || null,
        personal: personal as unknown as Prisma.InputJsonValue,
        observaciones: dto.observaciones || null,
        supervisorResponsable1: dto.supervisorResponsable1.trim(),
        supervisorResponsable2: dto.supervisorResponsable2?.trim() || null,
        supervisorId: userId,
        supervisorNombre: session.user.name?.trim() || session.user.email,
        inicio,
        fin: new Date(),
      },
    });
    // Solo las que siguen sin informe: si otro envío concurrente ya se
    // llevó alguna, el conteo no cuadra y se deshace todo (el informe
    // incluido) en vez de quedar con un lote a medias.
    const { count } = await tx.registroHorometro.updateMany({
      where: {
        id: { in: enlazar },
        supervisorId: userId,
        informeTemporalId: null,
      },
      data: { informeTemporalId: dto.id },
    });
    if (count !== enlazar.length) {
      throw new ConflictException({
        message:
          'Algunas tarjetas ya quedaron en otro informe. Recarga y vuelve a cerrar.',
        code: ERROR_CODES.INFORME_TARJETAS_DESCUADRADAS,
      });
    }
  }

  /**
   * `POST /api/informes-temporales/antiguo` — «Subir informe antiguo»: el
   * informe en papel de una jornada pasada, SIN tarjetas. Sus equipos van a
   * mano (`equiposRegistrados`) y no abren ni cierran nada, ni mueven
   * contadores. El N° es el del papel y tiene que estar libre (409
   * `NUMERO_EN_USO`).
   *
   * Quién: el supervisor temporal sube los suyos (`supervisorId` no aplica);
   * ADMIN/SECRETARIA eligen a qué supervisor temporal pertenece.
   *
   * Idempotente por `dto.id` (la cola offline reintenta): el reintento del
   * supervisor devuelve el suyo; el de la oficina, cualquiera subido después
   * (la oficina ve todos los informes).
   */
  async createAntiguo(
    dto: CreateInformeAntiguoDto,
    session: UserSession,
  ): Promise<InformeTemporalResponse> {
    const userId = session.user.id;
    const staff = esStaff(session);
    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe un informe con ese id.',
      findExisting: async (id) => {
        const existing = await this.findRecord(id);
        if (!existing) return null;
        return {
          ownerId:
            existing.supervisorId === userId || (staff && existing.antiguo)
              ? userId
              : existing.supervisorId,
          result: () => this.shape(existing),
        };
      },
      create: () => this.createAntiguoNuevo(dto, session, staff),
    });
  }

  private async createAntiguoNuevo(
    dto: CreateInformeAntiguoDto,
    session: UserSession,
    staff: boolean,
  ): Promise<InformeTemporalResponse> {
    const userId = session.user.id;
    assertOldRecordDateWithinWindow(dto.fecha);
    const personal = this.validarPersonal(dto);
    const supervisor = await this.supervisorDelAntiguo(dto, session, staff);
    const equipos = await this.validarEquipos(dto.equipos);
    await this.assertNumeroLibre(dto.numero);

    // La foto se reclama al final, ya validado todo: un rechazo antes no deja
    // una foto huérfana en el bucket.
    const fotoKey = dto.fotoKey
      ? await this.storage.claimTmp(dto.fotoKey, userId, 'trabajo-extra-photo')
      : null;
    // Sin tarjetas no hay ventana real: el instante va DENTRO del día del
    // informe (mismo criterio que la carga histórica).
    const instante = businessDayInstant(
      dto.fecha,
      dto.turno === 'NOCTURNO' ? '20:30' : '12:00',
    );
    try {
      await this.prisma.informeTemporal.create({
        data: {
          id: dto.id,
          numero: dto.numero,
          antiguo: true,
          equiposRegistrados: equipos as unknown as Prisma.InputJsonValue,
          fecha: parseDateOnlyUtc(dto.fecha),
          turno: dto.turno,
          actividad1: dto.actividad1.trim(),
          actividad2: dto.actividad2?.trim() || null,
          personal: personal as unknown as Prisma.InputJsonValue,
          observaciones: dto.observaciones || null,
          supervisorResponsable1: dto.supervisorResponsable1.trim(),
          supervisorResponsable2: dto.supervisorResponsable2?.trim() || null,
          supervisorId: supervisor.id,
          supervisorNombre: supervisor.nombre,
          inicio: instante,
          fin: instante,
          fotoKey,
        },
      });
    } catch (error) {
      // Otro se llevó el N° justo entre el chequeo y el insert.
      if (isUniqueViolationOn(error, 'numero')) {
        await this.assertNumeroLibre(dto.numero);
        throw new ConflictException({
          message: `El N° de informe ${dto.numero} ya está registrado.`,
          code: ERROR_CODES.NUMERO_EN_USO,
        });
      }
      throw error;
    }

    const creado = await this.findRecord(dto.id);
    if (!creado) throw new ConflictException('El informe ya no existe.');
    return this.shape(creado);
  }

  /** `GET /informes-temporales/numero-libre?numero=`: para avisar en el formulario. */
  async numeroLibre(numero: number): Promise<NumeroLibreResponse> {
    const tomado = await this.prisma.informeTemporal.findUnique({
      where: { numero },
      select: { id: true },
    });
    return { numero, libre: tomado == null };
  }

  /** 409 `NUMERO_EN_USO` si otro informe ya tiene ese N°. */
  private async assertNumeroLibre(numero: number): Promise<void> {
    const tomado = await this.prisma.informeTemporal.findUnique({
      where: { numero },
      select: { fecha: true, supervisorNombre: true },
    });
    if (tomado) {
      throw new ConflictException({
        message: `El N° de informe ${numero} ya está registrado (${tomado.supervisorNombre}, ${fechaLegible(formatDateOnly(tomado.fecha))}).`,
        code: ERROR_CODES.NUMERO_EN_USO,
      });
    }
  }

  /** El supervisor temporal dueño del informe subido después. */
  private async supervisorDelAntiguo(
    dto: CreateInformeAntiguoDto,
    session: UserSession,
    staff: boolean,
  ): Promise<{ id: string; nombre: string }> {
    if (!staff) {
      if (dto.supervisorId && dto.supervisorId !== session.user.id) {
        throw new ForbiddenException({
          message: 'Solo puedes subir tus propios informes.',
          code: ERROR_CODES.NOT_OWNER,
        });
      }
      return {
        id: session.user.id,
        nombre: session.user.name?.trim() || session.user.email,
      };
    }
    if (!dto.supervisorId) {
      throw new BadRequestException(
        'Elige a qué supervisor temporal pertenece el informe.',
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { id: dto.supervisorId },
      select: { id: true, name: true, email: true, role: true },
    });
    if (!user || !sessionHasRole(user.role, ROLES.SUPERVISOR_TEMPORAL)) {
      throw new BadRequestException(
        'El usuario elegido no es un supervisor temporal.',
      );
    }
    return { id: user.id, nombre: user.name?.trim() || user.email };
  }

  /**
   * Los equipos del papel con su snapshot del catálogo: cada uno existe, va
   * una sola vez y su lectura final no es menor que la inicial.
   */
  private async validarEquipos(
    filas: EquipoRegistradoDto[],
  ): Promise<EquipoRegistrado[]> {
    const ids = filas.map((f) => f.equipoId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Un equipo viene dos veces en el informe.');
    }
    const catalogo = await this.prisma.equipment.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        internalCode: true,
        equipmentClass: true,
        type: true,
        brand: true,
        model: true,
      },
    });
    const porId = new Map(catalogo.map((e) => [e.id, e]));
    return filas.map((f): EquipoRegistrado => {
      const equipo = porId.get(f.equipoId);
      if (!equipo) throw new NotFoundException('Equipo no encontrado');
      if (f.final < f.inicial) {
        throw new BadRequestException(
          `${equipo.internalCode}: la lectura final (${formatNumber(f.final)}) no puede ser menor que la inicial (${formatNumber(f.inicial)}).`,
        );
      }
      return {
        equipoId: equipo.id,
        codigo: equipo.internalCode,
        nombre: [equipo.type, equipo.brand, equipo.model]
          .filter(Boolean)
          .join(' '),
        unidad: equipo.equipmentClass === 'LIGHT' ? 'km' : 'h',
        inicial: f.inicial,
        final: f.final,
        litros: f.litros ?? null,
      };
    });
  }

  /**
   * `GET /api/informes-temporales` — del más nuevo al más viejo, con tope de
   * 500: el listado no pagina y el rango (`desde`/`hasta`, inclusivo sobre
   * `fecha`) es la forma de acotarlo.
   */
  async findAll(
    query: QueryInformesTemporalesDto,
  ): Promise<InformeTemporalResponse[]> {
    const fecha: Prisma.DateTimeFilter = {};
    if (query.desde) fecha.gte = parseDateOnlyUtc(query.desde);
    if (query.hasta) fecha.lte = parseDateOnlyUtc(query.hasta);
    const rows = await this.prisma.informeTemporal.findMany({
      where: query.desde || query.hasta ? { fecha } : {},
      include: INFORME_INCLUDE,
      orderBy: { numero: 'desc' },
      take: 500,
    });
    return Promise.all(rows.map((row) => this.shape(row)));
  }

  /**
   * `GET /api/informes-temporales/mine` — «Mis reportes» del supervisor
   * temporal: solo los que envió él, del más nuevo al más viejo, con tope de
   * 100 (es un historial para consultar en terreno, no un archivo).
   */
  async findMine(session: UserSession): Promise<InformeTemporalResponse[]> {
    const rows = await this.prisma.informeTemporal.findMany({
      where: { supervisorId: session.user.id },
      include: INFORME_INCLUDE,
      orderBy: { numero: 'desc' },
      take: 100,
    });
    return Promise.all(rows.map((row) => this.shape(row)));
  }

  /** Un supervisor temporal solo ve SUS informes; ADMIN/SECRETARIA, todos. */
  async findOne(
    id: string,
    session: UserSession,
  ): Promise<InformeTemporalResponse> {
    const informe = await this.findRecord(id);
    if (!informe) throw new NotFoundException('Informe no encontrado');
    if (!esStaff(session) && informe.supervisorId !== session.user.id) {
      throw new ForbiddenException({
        message: 'No puedes ver el informe de otro supervisor',
        code: ERROR_CODES.NOT_OWNER,
      });
    }
    return this.shape(informe);
  }

  /**
   * Corrige los datos del informe (no sus tarjetas ni sus cierres). Lo que
   * vino se monta sobre lo guardado y se valida el resultado; el cambio y su
   * `ChangeLog` van en la misma tx, y si nada cambió de verdad no se escribe.
   */
  async update(
    id: string,
    dto: UpdateInformeTemporalDto,
    session: UserSession,
  ): Promise<InformeTemporalResponse> {
    const editor = toEditor(session.user);
    await this.prisma.$transaction(async (tx) => {
      const actual = await tx.informeTemporal.findUnique({ where: { id } });
      if (!actual) throw new NotFoundException('Informe no encontrado');

      const antes: DatosInforme = {
        fecha: formatDateOnly(actual.fecha),
        turno: actual.turno,
        actividad1: actual.actividad1,
        actividad2: actual.actividad2,
        personal: actual.personal as unknown as InformePersonal[],
        observaciones: actual.observaciones,
        supervisorResponsable1: actual.supervisorResponsable1,
        supervisorResponsable2: actual.supervisorResponsable2,
      };
      const actividad2 =
        dto.actividad2 !== undefined
          ? dto.actividad2.trim() || null
          : antes.actividad2;
      const despues: DatosInforme = {
        fecha: dto.fecha ?? antes.fecha,
        turno: dto.turno ?? antes.turno,
        actividad1: dto.actividad1?.trim() ?? antes.actividad1,
        actividad2,
        // Se valida el resultado combinado: quitar la actividad 2 con
        // personal asignado a ella tiene que fallar aunque no venga `personal`.
        personal: this.validarPersonal({
          personal: dto.personal ?? antes.personal,
          actividad2,
        }),
        observaciones:
          dto.observaciones !== undefined
            ? dto.observaciones || null
            : antes.observaciones,
        supervisorResponsable1:
          dto.supervisorResponsable1?.trim() ?? antes.supervisorResponsable1,
        supervisorResponsable2:
          dto.supervisorResponsable2 !== undefined
            ? dto.supervisorResponsable2.trim() || null
            : antes.supervisorResponsable2,
      };

      const diff = diffFields<DatosInforme>(antes, despues, CAMPOS_INFORME);

      // Los equipos escritos a mano: solo en un informe subido después (en
      // uno normal son tarjetas, que se corrigen una por una). Son JSON: se
      // comparan y se registran por su resumen legible.
      let equipos: EquipoRegistrado[] | null = null;
      if (dto.equipos) {
        if (!actual.antiguo) {
          throw new BadRequestException(
            'Los equipos de este informe son tarjetas: se corrigen una por una.',
          );
        }
        const nuevos = await this.validarEquipos(dto.equipos);
        const resumenAntes = resumenEquipos(
          equiposDe(actual.equiposRegistrados),
        );
        const resumenDespues = resumenEquipos(nuevos);
        if (resumenAntes !== resumenDespues) {
          equipos = nuevos;
          diff.push({
            field: 'equiposRegistrados',
            label: 'Equipos',
            before: resumenAntes,
            after: resumenDespues,
          });
        }
      }
      if (diff.length === 0) return;

      await tx.informeTemporal.update({
        where: { id },
        data: {
          ...despues,
          fecha: parseDateOnlyUtc(despues.fecha),
          personal: despues.personal as unknown as Prisma.InputJsonValue,
          ...(equipos
            ? {
                equiposRegistrados: equipos as unknown as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
      await this.changeLog.record(tx, 'informe_temporal', id, editor, diff);
    });

    const editado = await this.findRecord(id);
    if (!editado) throw new NotFoundException('Informe no encontrado');
    return this.shape(editado);
  }

  /** Quién cambió qué y cuándo, del más reciente al más viejo. */
  findChanges(id: string) {
    return this.changeLog.findFor('informe_temporal', id);
  }

  /**
   * Elimina el informe CON sus tarjetas (solo ADMIN, ver controller). Cada
   * tarjeta se borra con `ShiftsService.removeCard` (cargas de combustible,
   * equipo, historial y aviso incluidos) y tiene su propia tx: si el proceso
   * se corta a la mitad, reintentar sigue donde quedó — una tarjeta que ya no
   * existe (NotFound) se da por borrada. El informe y su `ChangeLog` 'DELETE'
   * van juntos al final; la foto del report se suelta best-effort DESPUÉS de
   * borrar la fila (si el borrado falla, la foto sigue donde debe) — mismo
   * criterio que `TrabajosExtraService.remove`.
   */
  async remove(id: string, session: UserSession): Promise<void> {
    const informe = await this.findRecord(id);
    if (!informe) return;

    for (const { id: cardId } of informe.tarjetas) {
      try {
        await this.shifts.removeCard(cardId, session);
      } catch (e) {
        if (!(e instanceof NotFoundException)) throw e;
      }
    }

    const borrado = (field: string, label: string, before: string) => ({
      field,
      label,
      before,
      after: '—',
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.informeTemporal.delete({ where: { id } });
      await this.changeLog.record(
        tx,
        'informe_temporal',
        id,
        toEditor(session.user),
        [
          borrado(
            'informe',
            'Informe',
            `N° ${informe.numero} del ${formatDateOnly(informe.fecha)} (${informe.supervisorNombre})`,
          ),
          borrado(
            'tarjetas',
            'Tarjetas eliminadas',
            informe.tarjetas.map((t) => t.equipo.internalCode).join(', ') ||
              '—',
          ),
        ],
        'DELETE',
      );
    });

    if (informe.fotoKey) {
      await this.storage.deleteBestEffort(informe.fotoKey);
    }
  }

  /** Máx. 10 personas por actividad, y la actividad 2 solo si existe. */
  private validarPersonal(dto: {
    personal: PersonalInformeDto[];
    actividad2?: string | null;
  }): InformePersonal[] {
    const tieneActividad2 = !!dto.actividad2?.trim();
    const porActividad = (n: 1 | 2) =>
      dto.personal.filter((p: PersonalInformeDto) => p.actividad === n).length;
    if (porActividad(2) > 0 && !tieneActividad2) {
      throw new BadRequestException(
        'Hay personal en la actividad 2, pero el informe no tiene actividad 2.',
      );
    }
    for (const n of [1, 2] as const) {
      if (porActividad(n) > MAX_PERSONAL_POR_ACTIVIDAD) {
        throw new BadRequestException(
          `La actividad ${n} admite hasta ${MAX_PERSONAL_POR_ACTIVIDAD} personas.`,
        );
      }
    }
    return dto.personal.map((p) => ({
      actividad: p.actividad,
      operatorId: p.operatorId || null,
      nombre: p.nombre.trim(),
    }));
  }

  /**
   * 409 si el lote no cuadra con las pendientes: tienen que venir TODAS las
   * abiertas y nada fuera de las pendientes. Las ya cerradas (resto de un
   * intento anterior) pueden venir o no: se enlazan igual.
   */
  private async assertLoteCuadra(
    pendientes: {
      id: string;
      valorFinal: number | null;
      equipo: { internalCode: string };
    }[],
    cardIds: string[],
    userId: string,
  ): Promise<void> {
    const enviadas = new Set(cardIds);
    const pendientesIds = new Set(pendientes.map((card) => card.id));
    const faltan = pendientes.filter(
      (card) => card.valorFinal == null && !enviadas.has(card.id),
    );
    const sobran = cardIds.filter((id) => !pendientesIds.has(id));
    if (faltan.length === 0 && sobran.length === 0) return;

    // Las que sobran se nombran por su equipo solo si son del supervisor; una
    // ajena o inexistente se nombra por el id que mandó el propio cliente.
    const sobrantes =
      sobran.length > 0
        ? await this.prisma.registroHorometro.findMany({
            where: { id: { in: sobran }, supervisorId: userId },
            select: { id: true, equipo: { select: { internalCode: true } } },
          })
        : [];
    const codigoSobrante = new Map(
      sobrantes.map((card) => [card.id, card.equipo.internalCode]),
    );
    const codigos = [
      ...faltan.map((card) => card.equipo.internalCode),
      ...sobran.map((id) => codigoSobrante.get(id) ?? id),
    ];
    throw new ConflictException({
      message: `Faltan o sobran tarjetas: ${codigos.join(', ')}. Recarga y vuelve a cerrar.`,
      code: ERROR_CODES.INFORME_TARJETAS_DESCUADRADAS,
    });
  }

  private findRecord(id: string): Promise<InformeRecord | null> {
    return this.prisma.informeTemporal.findUnique({
      where: { id },
      include: INFORME_INCLUDE,
    });
  }

  private async shape(
    informe: InformeRecord,
  ): Promise<InformeTemporalResponse> {
    const {
      tarjetas,
      fecha,
      personal,
      fotoKey,
      equiposRegistrados,
      ...campos
    } = informe;
    return {
      ...campos,
      equiposRegistrados: equiposDe(equiposRegistrados),
      fecha: formatDateOnly(fecha),
      fotoUrl: fotoKey ? await this.storage.sign(fotoKey) : null,
      personal: personal as unknown as InformePersonal[],
      tarjetas: await Promise.all(
        tarjetas.map(async ({ equipo, pumpPhotoKey, ...card }) => ({
          id: card.id,
          equipo: {
            id: equipo.id,
            internalCode: equipo.internalCode,
            name: [equipo.type, equipo.brand, equipo.model]
              .filter(Boolean)
              .join(' '),
          },
          operador: card.operador,
          valorInicial: card.valorInicial,
          valorFinal: card.valorFinal,
          fuelLiters: card.fuelLiters,
          adBlueLiters: card.adBlueLiters,
          pumpPhotoUrl: pumpPhotoKey
            ? await this.storage.sign(pumpPhotoKey)
            : null,
          fecha: card.fecha,
          fechaSalida: card.fechaSalida,
        })),
      ),
    };
  }
}
