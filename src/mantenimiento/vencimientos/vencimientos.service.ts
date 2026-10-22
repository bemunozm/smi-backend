import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import type {
  DocumentExpiringEvent,
  LightServiceDueEvent,
} from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  buildDocumentExpiryInfo,
  type DocumentStatus,
} from '../../equipment/document-expiry';
import { MaintenancePlansService } from '../maintenance-plans/maintenance-plans.service';
import type { Editor } from '../../change-log/change-log.service';
import {
  LIGHT_DOC_ALERT_FIELD,
  lightConfigOf,
  type LightConfig,
} from './light-config';
import {
  DOCUMENT_TYPE_LABEL,
  DOCUMENT_TYPES_WITHOUT_EXPIRY,
  LIGHT_SERVICE_INTERVAL_KM,
  documentAlertKind,
  nextLightService,
} from './vencimientos-rules';

/** Cada cuánto se revisan los vencimientos. Los documentos vencen por día; el
 * odómetro lo mueven Flota y Terreno en cualquier momento. */
const REVISION_MS = 60 * 60 * 1000;
/** La primera revisión, un rato después de levantar (no en pleno arranque). */
const PRIMERA_REVISION_MS = 60 * 1000;

const fmt = (n: number) => n.toLocaleString('es-CL');

/** `YYYY-MM-DD` de una fecha guardada como día (medianoche UTC). */
const diaDe = (d: Date) => d.toISOString().slice(0, 10);

export interface CalendarDocument {
  id: string;
  type: string;
  /** «Revisión técnica», «Seguro»… o el título si es «Otro». */
  label: string;
  /** `YYYY-MM-DD`. */
  expiryDate: string;
  /** `YYYY-MM`: la columna del calendario donde cae. */
  month: string;
  status: DocumentStatus;
  daysToExpiry: number | null;
  alertDaysBefore: number;
}

export interface CalendarService {
  /** De dónde sale: la pauta propia del equipo o la regla de livianos (10.000 km). */
  source: 'PAUTA' | 'LIVIANO';
  unit: 'h' | 'km';
  /** El contador en que toca la próxima mantención. */
  nextAt: number;
  remaining: number;
  /** Ya está dentro del margen de aviso. */
  due: boolean;
}

export interface CalendarEquipment {
  id: string;
  internalCode: string;
  licensePlate: string | null;
  type: string;
  brand: string;
  model: string;
  controlUnit: 'KM' | 'HOURS';
  counter: number | null;
  /** Documentos con vencimiento: los vencidos y los del año del calendario. */
  documents: CalendarDocument[];
  service: CalendarService | null;
}

/** «Asignar mantenciones» de un liviano: su configuración y cómo está hoy. */
export interface LightConfigView {
  equipment: {
    id: string;
    internalCode: string;
    licensePlate: string | null;
    brand: string;
    model: string;
    /** Odómetro actual, o `null` sin lectura. */
    mileage: number | null;
  };
  /** Siempre 10.000 km (no se configura). */
  intervalKm: number;
  config: LightConfig;
  /** La próxima mantención con el aviso configurado, o `null` sin odómetro. */
  service: CalendarService | null;
  /** El papel vigente más próximo de cada tipo con vencimiento, si hay. */
  documents: {
    type: 'TECHNICAL_INSPECTION' | 'CIRCULATION_PERMIT' | 'INSURANCE';
    label: string;
    expiryDate: string | null;
    daysToExpiry: number | null;
    status: DocumentStatus | null;
  }[];
}

export interface CalendarView {
  /** Los 12 meses del calendario (`YYYY-MM`), desde el pedido. */
  months: string[];
  equipment: CalendarEquipment[];
}

/**
 * Módulo 4 · R21 — alertas de vencimiento documental y mantención de livianos.
 *
 * - **Documentos**: cada uno avisa con su propia anticipación
 *   (`alertDaysBefore`). La revisión periódica le avisa al mantenedor y al
 *   administrador cuando entra en el plazo y cuando vence, una sola vez por
 *   vencimiento (`DocumentExpiryAlert`): si se renueva con otra fecha, vuelve
 *   a avisar.
 * - **Livianos**: todo vehículo liviano controlado por km y SIN pauta propia
 *   tiene mantención cada 10.000 km. A 1.000 km se crea la orden PREVENTIVA en
 *   el tablero del taller y se avisa. Con pauta propia, manda la pauta (que ya
 *   crea su propia orden).
 * - **Calendario**: 12 meses por patente con lo que vence y la próxima
 *   mantención.
 */
@Injectable()
export class VencimientosService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VencimientosService.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly plans: MaintenancePlansService,
  ) {}

  onModuleInit(): void {
    // En los tests no corre: cada suite levantaría sus propios temporizadores.
    if (process.env.NODE_ENV === 'test') return;
    const primera = setTimeout(() => void this.checkAll(), PRIMERA_REVISION_MS);
    const periodica = setInterval(() => void this.checkAll(), REVISION_MS);
    primera.unref();
    periodica.unref();
    this.timers = [primera, periodica];
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  /** Revisa documentos y livianos. Devuelve cuántos avisos nuevos salieron. */
  async checkAll(
    now: Date = new Date(),
  ): Promise<{ documents: number; lightServices: number }> {
    const resultado = { documents: 0, lightServices: 0 };
    try {
      resultado.documents = await this.checkDocuments(now);
    } catch (error) {
      this.logger.error(
        'No se pudieron revisar los vencimientos de documentos',
        error instanceof Error ? error.stack : undefined,
      );
    }
    try {
      resultado.lightServices = await this.checkLightServices();
    } catch (error) {
      this.logger.error(
        'No se pudo revisar la mantención de los livianos',
        error instanceof Error ? error.stack : undefined,
      );
    }
    return resultado;
  }

  /** Avisa los documentos que entraron en su plazo o vencieron. */
  async checkDocuments(now: Date = new Date()): Promise<number> {
    const documentos = await this.prisma.equipmentDocument.findMany({
      where: {
        expiryDate: { not: null },
        type: { notIn: [...DOCUMENT_TYPES_WITHOUT_EXPIRY] },
      },
      include: {
        equipment: {
          select: { id: true, internalCode: true, licensePlate: true },
        },
      },
    });

    let avisados = 0;
    for (const doc of documentos) {
      const kind = documentAlertKind(doc.expiryDate, doc.alertDaysBefore, now);
      if (!kind || !doc.expiryDate) continue;
      try {
        await this.prisma.documentExpiryAlert.create({
          data: { documentId: doc.id, kind, expiryDate: doc.expiryDate },
        });
      } catch (error) {
        // Ya se avisó este vencimiento (índice único): no se repite.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          continue;
        }
        throw error;
      }
      const { daysToExpiry } = buildDocumentExpiryInfo(
        doc.expiryDate,
        now,
        doc.alertDaysBefore,
      );
      this.eventEmitter.emit(DOMAIN_EVENTS.DOCUMENT_EXPIRING, {
        documentId: doc.id,
        equipmentId: doc.equipment.id,
        equipmentCode: doc.equipment.internalCode,
        licensePlate: doc.equipment.licensePlate,
        documentLabel: this.etiqueta(doc.type, doc.title),
        kind,
        expiryDate: diaDe(doc.expiryDate),
        daysToExpiry: daysToExpiry ?? 0,
      } satisfies DocumentExpiringEvent);
      avisados++;
    }
    return avisados;
  }

  /**
   * Crea la orden PREVENTIVA de los livianos (sin pauta propia) que están a
   * 1.000 km o menos de su mantención, una sola por equipo y kilometraje.
   */
  async checkLightServices(): Promise<number> {
    const [livianos, conPauta] = await Promise.all([
      this.prisma.equipment.findMany({
        where: {
          equipmentClass: 'LIGHT',
          controlUnit: 'KM',
          currentMileage: { not: null },
          status: { not: 'OUT_OF_SERVICE' },
        },
        select: {
          id: true,
          internalCode: true,
          licensePlate: true,
          currentMileage: true,
        },
      }),
      this.prisma.maintenancePlan.findMany({ select: { equipmentId: true } }),
    ]);
    const tienePauta = new Set(conPauta.map((p) => p.equipmentId));
    const avisoKm = await this.avisosKm();

    let creadas = 0;
    for (const equipo of livianos) {
      if (tienePauta.has(equipo.id)) continue;
      const servicio = nextLightService(
        equipo.currentMileage,
        LIGHT_SERVICE_INTERVAL_KM,
        avisoKm.get(equipo.id),
      );
      if (!servicio?.due) continue;

      // Es lo que identifica la orden de ese kilometraje (y lo que muestra el
      // tablero como origen).
      const origenDetalle = `Livianos: mantención de ${fmt(servicio.nextKm)} km`;
      const ordenId = await this.prisma.$transaction(async (tx) => {
        // La revisión periódica y otra simultánea no crean dos tarjetas.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`aviso-liviano:${equipo.id}`}))`;
        const existente = await tx.ordenTrabajo.findFirst({
          where: { equipoId: equipo.id, origen: 'PREVENTIVO', origenDetalle },
          select: { id: true },
        });
        if (existente) return null;
        const orden = await tx.ordenTrabajo.create({
          data: {
            equipoId: equipo.id,
            titulo: `Mantención ${fmt(servicio.nextKm)} km · ${equipo.internalCode}`,
            tipo: 'PREVENTIVA',
            origen: 'PREVENTIVO',
            origenDetalle,
            prioridad: servicio.remainingKm <= 0 ? 'ALTA' : 'MEDIA',
          },
          select: { id: true },
        });
        return orden.id;
      });
      if (!ordenId) continue;

      this.logger.log(
        `Orden de mantención de ${fmt(servicio.nextKm)} km creada para ${equipo.internalCode} (faltan ${fmt(servicio.remainingKm)} km)`,
      );
      this.eventEmitter.emit(DOMAIN_EVENTS.LIGHT_SERVICE_DUE, {
        equipmentId: equipo.id,
        equipmentCode: equipo.internalCode,
        licensePlate: equipo.licensePlate,
        ordenId,
        nextKm: servicio.nextKm,
        remainingKm: servicio.remainingKm,
      } satisfies LightServiceDueEvent);
      creadas++;
    }
    return creadas;
  }

  /**
   * El calendario anual de los vehículos livianos: 12 meses desde `desde`
   * (`YYYY-MM`, por defecto el mes actual), con los documentos que vencen en
   * cada mes —más los ya vencidos— y la próxima mantención. La mantención va
   * por km, sin fecha: se muestra cuánto falta.
   */
  async calendar(
    desde?: string,
    now: Date = new Date(),
    /** Solo ese equipo (la tarjeta de la ficha del liviano). */
    equipmentId?: string,
  ): Promise<CalendarView> {
    const months = this.meses(desde, now);
    const fin = new Date(`${this.mesSiguiente(months[11])}-01T00:00:00.000Z`);

    const equipos = await this.prisma.equipment.findMany({
      where: {
        equipmentClass: 'LIGHT',
        ...(equipmentId ? { id: equipmentId } : {}),
      },
      orderBy: { internalCode: 'asc' },
      select: {
        id: true,
        internalCode: true,
        licensePlate: true,
        type: true,
        brand: true,
        model: true,
        controlUnit: true,
        currentMileage: true,
        currentHourmeter: true,
        documents: {
          where: {
            expiryDate: { not: null, lt: fin },
            type: { notIn: [...DOCUMENT_TYPES_WITHOUT_EXPIRY] },
          },
          orderBy: { expiryDate: 'asc' },
          select: {
            id: true,
            type: true,
            title: true,
            expiryDate: true,
            alertDaysBefore: true,
          },
        },
      },
    });

    const pautas = new Map(
      (await this.plans.statusForAll()).map((p) => [p.equipmentId, p]),
    );
    const avisoKm = await this.avisosKm();

    return {
      months,
      equipment: equipos.map((e) => {
        const counter =
          e.controlUnit === 'KM' ? e.currentMileage : e.currentHourmeter;
        return {
          id: e.id,
          internalCode: e.internalCode,
          licensePlate: e.licensePlate,
          type: e.type,
          brand: e.brand,
          model: e.model,
          controlUnit: e.controlUnit,
          counter,
          documents: e.documents.map((d) => {
            const expiry = d.expiryDate as Date;
            const info = buildDocumentExpiryInfo(
              expiry,
              now,
              d.alertDaysBefore,
            );
            return {
              id: d.id,
              type: d.type,
              label: this.etiqueta(d.type, d.title),
              expiryDate: diaDe(expiry),
              month: diaDe(expiry).slice(0, 7),
              status: info.status,
              daysToExpiry: info.daysToExpiry,
              alertDaysBefore: d.alertDaysBefore,
            };
          }),
          service: this.servicio(
            e,
            counter,
            pautas.get(e.id),
            avisoKm.get(e.id),
          ),
        };
      }),
    };
  }

  private servicio(
    e: { controlUnit: 'KM' | 'HOURS' },
    counter: number | null,
    pauta:
      | Awaited<ReturnType<MaintenancePlansService['statusForAll']>>[number]
      | undefined,
    alertKm?: number,
  ): CalendarService | null {
    if (pauta?.status.next) {
      const next = pauta.status.next;
      return {
        source: 'PAUTA',
        unit: pauta.unit,
        nextAt: next.dueAt,
        remaining: next.remaining,
        due: pauta.alertBefore != null && next.remaining <= pauta.alertBefore,
      };
    }
    if (e.controlUnit !== 'KM') return null;
    const liviano = nextLightService(
      counter,
      LIGHT_SERVICE_INTERVAL_KM,
      alertKm,
    );
    if (!liviano) return null;
    return {
      source: 'LIVIANO',
      unit: 'km',
      nextAt: liviano.nextKm,
      remaining: liviano.remainingKm,
      due: liviano.due,
    };
  }

  /** «Asignar mantenciones» de un liviano: configuración, mantención y papeles. */
  async lightConfig(
    equipmentId: string,
    now: Date = new Date(),
  ): Promise<LightConfigView> {
    const equipo = await this.liviano(equipmentId);
    const config = await lightConfigOf(this.prisma, equipmentId);
    const documentos = await this.prisma.equipmentDocument.findMany({
      where: {
        equipmentId,
        type: {
          in: ['TECHNICAL_INSPECTION', 'CIRCULATION_PERMIT', 'INSURANCE'],
        },
        expiryDate: { not: null },
      },
      orderBy: { expiryDate: 'desc' },
      select: { type: true, expiryDate: true, alertDaysBefore: true },
    });
    const tipos = [
      'TECHNICAL_INSPECTION',
      'CIRCULATION_PERMIT',
      'INSURANCE',
    ] as const;
    return {
      equipment: {
        id: equipo.id,
        internalCode: equipo.internalCode,
        licensePlate: equipo.licensePlate,
        brand: equipo.brand,
        model: equipo.model,
        mileage: equipo.currentMileage,
      },
      intervalKm: LIGHT_SERVICE_INTERVAL_KM,
      config,
      service: this.servicio(
        { controlUnit: 'KM' },
        equipo.currentMileage,
        undefined,
        config.serviceAlertKm,
      ),
      documents: tipos.map((type) => {
        // El más nuevo de ese tipo: es el que está corriendo.
        const doc = documentos.find((d) => d.type === type);
        const info = doc
          ? buildDocumentExpiryInfo(
              doc.expiryDate,
              now,
              config[LIGHT_DOC_ALERT_FIELD[type]!],
            )
          : null;
        return {
          type,
          label: DOCUMENT_TYPE_LABEL[type],
          expiryDate: doc?.expiryDate ? diaDe(doc.expiryDate) : null,
          daysToExpiry: info?.daysToExpiry ?? null,
          status: info?.status ?? null,
        };
      }),
    };
  }

  /**
   * Guarda la configuración del liviano y la aplica: los papeles de cada tipo
   * del vehículo quedan con esos días de aviso, y se revisa de inmediato por
   * si con los nuevos márgenes ya corresponde avisar.
   */
  async saveLightConfig(
    equipmentId: string,
    config: LightConfig,
    editor: Editor,
  ): Promise<LightConfigView> {
    await this.liviano(equipmentId);
    await this.prisma.$transaction(async (tx) => {
      await tx.lightVehicleConfig.upsert({
        where: { equipmentId },
        create: { equipmentId, ...config, updatedById: editor.id },
        update: { ...config, updatedById: editor.id },
      });
      for (const [type, campo] of Object.entries(LIGHT_DOC_ALERT_FIELD)) {
        await tx.equipmentDocument.updateMany({
          where: {
            equipmentId,
            type: type as keyof typeof LIGHT_DOC_ALERT_FIELD,
          },
          data: { alertDaysBefore: config[campo] },
        });
      }
    });
    await this.checkAll();
    return this.lightConfig(equipmentId);
  }

  private async liviano(equipmentId: string) {
    const equipo = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: {
        id: true,
        internalCode: true,
        licensePlate: true,
        brand: true,
        model: true,
        equipmentClass: true,
        currentMileage: true,
      },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');
    if (equipo.equipmentClass !== 'LIGHT') {
      throw new BadRequestException(
        'Este equipo no es liviano: usa la pauta de mantención por hitos.',
      );
    }
    return equipo;
  }

  /** Los km de aviso configurados, por equipo (los que no tienen, usan el de defecto). */
  private async avisosKm(): Promise<Map<string, number>> {
    const filas = await this.prisma.lightVehicleConfig.findMany({
      select: { equipmentId: true, serviceAlertKm: true },
    });
    return new Map(filas.map((f) => [f.equipmentId, f.serviceAlertKm]));
  }

  private etiqueta(type: string, title: string | null): string {
    if (type === 'OTHER' || type === 'CERTIFICATION') {
      return title?.trim() || DOCUMENT_TYPE_LABEL[type] || 'Documento';
    }
    return DOCUMENT_TYPE_LABEL[type] ?? title ?? 'Documento';
  }

  /** Los 12 meses `YYYY-MM` desde `desde` (o el mes de `now`). */
  private meses(desde: string | undefined, now: Date): string[] {
    let inicio = desde;
    if (inicio === undefined) {
      inicio = now.toISOString().slice(0, 7);
    } else if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(inicio)) {
      throw new BadRequestException('El mes tiene que ser YYYY-MM.');
    }
    const meses = [inicio];
    while (meses.length < 12) meses.push(this.mesSiguiente(meses.at(-1)!));
    return meses;
  }

  private mesSiguiente(mes: string): string {
    const [y, m] = mes.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
}
