import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { UserSession } from '@thallesp/nestjs-better-auth';

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
  fotosEnviadas: boolean;
  infoSubidaApp: boolean;
  supervisorId: string;
  supervisorNombre: string;
  inicio: Date;
  fin: Date;
  createdAt: Date;
  updatedAt: Date;
  tarjetas: InformeTemporalTarjetaResponse[];
}

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
   * reintento tiene que poder completarlo.
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

    const pendientes = await this.prisma.registroHorometro.findMany({
      where: {
        supervisorId: userId,
        temporal: true,
        informeTemporalId: null,
        OR: [
          { valorFinal: null },
          { closeClientId: { in: dto.cierres.map((c) => c.closeClientId) } },
        ],
      },
      select: {
        id: true,
        fecha: true,
        equipo: { select: { internalCode: true } },
      },
    });
    await this.assertLoteCuadra(pendientes, cardIds, userId);

    for (const { cardId, ...cierre } of dto.cierres) {
      await this.shifts.closeCard(cardId, cierre, session, {
        viaInforme: true,
      });
    }

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
          fotosEnviadas: dto.fotosEnviadas,
          infoSubidaApp: dto.infoSubidaApp,
          supervisorId: userId,
          supervisorNombre: session.user.name?.trim() || session.user.email,
          inicio,
          fin: new Date(),
        },
      });
      await tx.registroHorometro.updateMany({
        where: { id: { in: cardIds }, supervisorId: userId },
        data: { informeTemporalId: dto.id },
      });
    });

    const creado = await this.findRecord(dto.id);
    // Recién creado en la tx de arriba: solo falta si alguien lo borró entre
    // medio, y entonces no hay nada que devolver.
    if (!creado) throw new ConflictException('El informe ya no existe.');
    return this.shape(creado);
  }

  /** Máx. 10 personas por actividad, y la actividad 2 solo si existe. */
  private validarPersonal(dto: CreateInformeTemporalDto): InformePersonal[] {
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

  /** 409 si el lote no son EXACTAMENTE las tarjetas pendientes. */
  private async assertLoteCuadra(
    pendientes: { id: string; equipo: { internalCode: string } }[],
    cardIds: string[],
    userId: string,
  ): Promise<void> {
    const enviadas = new Set(cardIds);
    const pendientesIds = new Set(pendientes.map((card) => card.id));
    const faltan = pendientes.filter((card) => !enviadas.has(card.id));
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
