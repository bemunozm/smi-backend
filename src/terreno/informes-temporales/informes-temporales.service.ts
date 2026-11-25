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
import { createOrReturn } from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { formatDateOnly, parseDateOnlyUtc } from '../../shifts/date-only';
import { ShiftsService } from '../../shifts/shifts.service';
import { StorageService } from '../../storage/storage.service';
import {
  CreateInformeTemporalDto,
  MAX_PERSONAL_POR_ACTIVIDAD,
  type PersonalInformeDto,
} from './dto/create-informe-temporal.dto';
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

export interface InformeTemporalResponse {
  id: string;
  numero: number;
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
    await this.prisma.$transaction(async (tx) => {
      await tx.informeTemporal.create({
        data: {
          id: dto.id,
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
    });

    const creado = await this.findRecord(dto.id);
    // Recién creado en la tx de arriba: solo falta si alguien lo borró entre
    // medio, y entonces no hay nada que devolver.
    if (!creado) throw new ConflictException('El informe ya no existe.');
    return this.shape(creado);
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

  /** Un supervisor temporal solo ve SUS informes; ADMIN/SECRETARIA, todos. */
  async findOne(
    id: string,
    session: UserSession,
  ): Promise<InformeTemporalResponse> {
    const informe = await this.findRecord(id);
    if (!informe) throw new NotFoundException('Informe no encontrado');
    const esStaff =
      sessionHasRole(session.user.role, ROLES.ADMIN) ||
      sessionHasRole(session.user.role, ROLES.SECRETARIA);
    if (!esStaff && informe.supervisorId !== session.user.id) {
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
      if (diff.length === 0) return;

      await tx.informeTemporal.update({
        where: { id },
        data: {
          ...despues,
          fecha: parseDateOnlyUtc(despues.fecha),
          personal: despues.personal as unknown as Prisma.InputJsonValue,
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
   * van juntos al final.
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
    const { tarjetas, fecha, personal, ...campos } = informe;
    return {
      ...campos,
      fecha: formatDateOnly(fecha),
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
