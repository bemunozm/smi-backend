import { BadRequestException, Injectable } from '@nestjs/common';

import type { FieldChange } from '../change-log/change-log.service';
import {
  businessDayKey,
  todayInBusinessTimeZone,
} from '../common/dates/business-time';
import { formatNumber } from '../common/format/number';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  DATE_ONLY_REGEX,
  formatDateOnly,
  parseDateOnlyUtc,
} from '../shifts/date-only';
import { resolveNombresUsuarios } from '../terreno/common/registrado-por.util';

/** De qué módulo es el evento — la etiqueta y el filtro «Módulo» del panel. */
export type ActivityKind =
  | 'FUEL_LOAD'
  | 'SHIFT_CARD'
  | 'DAILY_REPORT'
  | 'EXTRA_WORK'
  | 'FINDING'
  | 'WORK_ORDER'
  | 'MAINTENANCE'
  | 'EXIT_REPORT'
  | 'OTHER';

/** Qué se hizo. `CLOSED` cubre el cierre de tarjeta y la mantención
 * realizada; `UPDATED`/`DELETED` salen del historial de cambios. */
export type ActivityAction = 'CREATED' | 'CLOSED' | 'UPDATED' | 'DELETED';

export interface ActivityEvent {
  /** `fuente:acción:id de la fila` — único dentro del feed. */
  id: string;
  kind: ActivityKind;
  action: ActivityAction;
  /** Cuándo se HIZO la acción en la plataforma (hora de servidor). */
  occurredAt: Date;
  /** `YYYY-MM-DD` del día de negocio al que corresponde el DATO (el día de
   * la carga, del turno, del reporte). Null cuando no aplica (ediciones). */
  dataDate: string | null;
  /** `true` cuando se registró en un día distinto al del dato — un registro
   * retroactivo (reporte antiguo, carga de un turno pasado). */
  backdated: boolean;
  /** Quién lo hizo, ya resuelto a nombre. Null si la cuenta se eliminó. */
  actorName: string | null;
  /** Resumen legible armado acá (equipo, litros, turno…), listo para la tabla. */
  summary: string;
  /** Solo ediciones/eliminaciones: el antes → después de cada dato. */
  changes: FieldChange[] | null;
}

export interface ActivityFeed {
  from: string;
  to: string;
  /** Del más reciente al más antiguo (por `occurredAt`). */
  events: ActivityEvent[];
}

/** Cómo entra cada entidad del historial de cambios al feed. */
const ENTITY_KIND: Record<string, { kind: ActivityKind; label: string }> = {
  trabajo_extra: { kind: 'EXTRA_WORK', label: 'Report' },
  hallazgo: { kind: 'FINDING', label: 'Hallazgo' },
  shift_card: { kind: 'SHIFT_CARD', label: 'Tarjeta de turno' },
  maintenance_plan: { kind: 'MAINTENANCE', label: 'Pauta de mantención' },
  reporte_diario: { kind: 'DAILY_REPORT', label: 'Producción diaria' },
  combustible: { kind: 'FUEL_LOAD', label: 'Carga de combustible' },
};

const TIPO_COMBUSTIBLE: Record<string, string> = {
  PETROLEO: 'petróleo',
  BENCINA: 'bencina',
};

const DIA_MS = 24 * 60 * 60 * 1000;

/** Hasta 3 meses por consulta: el feed junta varias tablas y sin tope una
 * URL manipulada podría pedir años enteros de una vez. */
const RANGO_MAX_DIAS = 92;

function turnoLabel(turno: string): string {
  if (turno === 'DIURNO') return 'turno día';
  if (turno === 'NOCTURNO') return 'turno noche';
  return turno;
}

/**
 * Registro de actividad del administrador (`GET /api/activity-log`): TODO lo
 * que los supervisores (y el resto de la operación) registran, en una sola
 * línea de tiempo con dos fechas por evento — cuándo se hizo en la
 * plataforma (`occurredAt`) y a qué día corresponde el dato (`dataDate`) —
 * para ver de un vistazo qué se guardó y qué entró retroactivo.
 *
 * Es un read-model: NO tiene tabla propia. Las creaciones salen de las tablas
 * de cada dominio (por eso lo ya registrado aparece desde el primer día) y
 * las ediciones/eliminaciones, del historial de cambios (`ChangeLog`). El eje
 * de tiempo del feed es siempre el instante en que se ACTUÓ, no el día del
 * dato: la pregunta del administrador es «¿qué hicieron hoy/esta semana?».
 */
@Injectable()
export class ActivityLogService {
  constructor(private readonly prisma: PrismaService) {}

  async feed(from?: string, to?: string): Promise<ActivityFeed> {
    const hasta = to ?? todayInBusinessTimeZone(new Date());
    const desde =
      from ??
      formatDateOnly(new Date(parseDateOnlyUtc(hasta).getTime() - 6 * DIA_MS));
    if (!DATE_ONLY_REGEX.test(desde) || !DATE_ONLY_REGEX.test(hasta)) {
      throw new BadRequestException('Fecha inválida: se espera YYYY-MM-DD');
    }
    if (desde > hasta) {
      throw new BadRequestException('El rango está invertido: desde > hasta');
    }
    const dias =
      (parseDateOnlyUtc(hasta).getTime() - parseDateOnlyUtc(desde).getTime()) /
        DIA_MS +
      1;
    if (dias > RANGO_MAX_DIAS) {
      throw new BadRequestException(
        `El rango no puede superar los ${RANGO_MAX_DIAS} días`,
      );
    }

    // Ventana ancha por instante (absorbe el huso de Chile vs UTC); el día
    // FINO se decide en memoria con `businessDayKey` — mismo criterio que
    // Asistencia.
    const gte = new Date(parseDateOnlyUtc(desde).getTime() - DIA_MS);
    const lte = new Date(parseDateOnlyUtc(hasta).getTime() + 2 * DIA_MS);
    const enRango = (instante: Date) => {
      const ymd = businessDayKey(instante);
      return ymd >= desde && ymd <= hasta;
    };

    const [
      cargas,
      tarjetas,
      reportes,
      trabajos,
      hallazgos,
      ordenes,
      intervenciones,
      salidas,
      cambios,
    ] = await Promise.all([
      this.prisma.registroCombustible.findMany({
        // `createdAt` es nullable en filas viejas sin backfill: esas caen por
        // su `fecha` (la mejor aproximación de cuándo se registraron).
        where: {
          OR: [
            { createdAt: { gte, lte } },
            { createdAt: null, fecha: { gte, lte } },
          ],
        },
        select: {
          id: true,
          litros: true,
          tipo: true,
          fecha: true,
          createdAt: true,
          createdById: true,
          registroHorometroId: true,
          equipo: { select: { internalCode: true } },
          registroHorometro: {
            select: {
              closedById: true,
              closedByName: true,
              supervisorId: true,
            },
          },
        },
      }),
      this.prisma.registroHorometro.findMany({
        where: {
          OR: [{ createdAt: { gte, lte } }, { closedAt: { gte, lte } }],
        },
        select: {
          id: true,
          operador: true,
          turno: true,
          fecha: true,
          createdAt: true,
          closedAt: true,
          closedById: true,
          closedByName: true,
          supervisorId: true,
          fuelLiters: true,
          equipo: { select: { internalCode: true } },
          shift: { select: { date: true } },
        },
      }),
      this.prisma.reporteDiario.findMany({
        where: { createdAt: { gte, lte } },
        select: {
          id: true,
          fecha: true,
          turno: true,
          supervisorId: true,
          supervisorNombre: true,
          createdAt: true,
        },
      }),
      this.prisma.trabajoExtraordinario.findMany({
        where: { createdAt: { gte, lte } },
        select: {
          id: true,
          numero: true,
          fecha: true,
          operador: true,
          totalHoras: true,
          createdAt: true,
          createdById: true,
          equipo: { select: { internalCode: true } },
        },
      }),
      this.prisma.hallazgo.findMany({
        where: { createdAt: { gte, lte } },
        select: {
          id: true,
          tipo: true,
          descripcion: true,
          prioridad: true,
          faena: true,
          lugar: true,
          fecha: true,
          createdAt: true,
          createdById: true,
          equipo: { select: { internalCode: true } },
        },
      }),
      this.prisma.ordenTrabajo.findMany({
        where: { createdAt: { gte, lte } },
        select: {
          id: true,
          titulo: true,
          equipoId: true,
          createdAt: true,
          createdById: true,
        },
      }),
      this.prisma.intervencion.findMany({
        where: { fecha: { gte, lte } },
        select: {
          id: true,
          detalle: true,
          fecha: true,
          realizadaPorId: true,
          createdById: true,
          orden: { select: { titulo: true, equipoId: true } },
        },
      }),
      this.prisma.shiftExitReport.findMany({
        where: { createdAt: { gte, lte } },
        select: {
          id: true,
          cardCount: true,
          createdAt: true,
          createdById: true,
          shift: { select: { date: true, type: true } },
        },
      }),
      this.prisma.changeLog.findMany({ where: { createdAt: { gte, lte } } }),
    ]);

    // `equipoId` de Mantenimiento es soft ref (sin include posible): un solo
    // lookup para los códigos internos de OTs e intervenciones.
    const equipoIds = [
      ...new Set(
        [
          ...ordenes.map((o) => o.equipoId),
          ...intervenciones.map((i) => i.orden?.equipoId),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    const equipos = equipoIds.length
      ? await this.prisma.equipment.findMany({
          where: { id: { in: equipoIds } },
          select: { id: true, internalCode: true },
        })
      : [];
    const codigoEquipo = new Map(equipos.map((e) => [e.id, e.internalCode]));

    const nombres = await resolveNombresUsuarios(this.prisma, [
      ...cargas.map((c) => c.createdById),
      ...cargas.map((c) => c.registroHorometro?.closedById),
      ...cargas.map((c) => c.registroHorometro?.supervisorId),
      ...tarjetas.map((t) => t.supervisorId),
      ...tarjetas.map((t) => t.closedById),
      ...reportes.map((r) => r.supervisorId),
      ...trabajos.map((t) => t.createdById),
      ...hallazgos.map((h) => h.createdById),
      ...ordenes.map((o) => o.createdById),
      ...intervenciones.map((i) => i.realizadaPorId),
      ...intervenciones.map((i) => i.createdById),
      ...salidas.map((s) => s.createdById),
    ]);
    const nombre = (id: string | null | undefined) =>
      id ? (nombres.get(id) ?? null) : null;

    const events: ActivityEvent[] = [];
    const push = (
      e: Omit<ActivityEvent, 'backdated'> & { backdated?: boolean },
    ) => {
      if (!enRango(e.occurredAt)) return;
      events.push({
        ...e,
        backdated:
          e.dataDate != null && businessDayKey(e.occurredAt) !== e.dataDate,
      });
    };

    for (const c of cargas) {
      const deTarjeta = Boolean(c.registroHorometroId);
      push({
        id: `fuel:created:${c.id}`,
        kind: 'FUEL_LOAD',
        action: 'CREATED',
        occurredAt: c.createdAt ?? c.fecha,
        dataDate: businessDayKey(c.fecha),
        actorName: deTarjeta
          ? (c.registroHorometro?.closedByName ??
            nombre(c.registroHorometro?.closedById) ??
            nombre(c.registroHorometro?.supervisorId))
          : nombre(c.createdById),
        summary: `${c.equipo.internalCode} · ${formatNumber(c.litros)} L ${
          TIPO_COMBUSTIBLE[c.tipo] ?? c.tipo
        } · ${deTarjeta ? 'cierre de tarjeta' : 'manual'}`,
        changes: null,
      });
    }

    for (const t of tarjetas) {
      const dataDate = t.shift
        ? formatDateOnly(t.shift.date)
        : businessDayKey(t.fecha);
      const base = `${t.equipo.internalCode} · ${t.operador} · ${turnoLabel(t.turno)}`;
      push({
        id: `card:created:${t.id}`,
        kind: 'SHIFT_CARD',
        action: 'CREATED',
        occurredAt: t.createdAt,
        dataDate,
        actorName: nombre(t.supervisorId),
        summary: base,
        changes: null,
      });
      if (t.closedAt) {
        push({
          id: `card:closed:${t.id}`,
          kind: 'SHIFT_CARD',
          action: 'CLOSED',
          occurredAt: t.closedAt,
          dataDate,
          actorName:
            t.closedByName ?? nombre(t.closedById) ?? nombre(t.supervisorId),
          summary:
            t.fuelLiters && t.fuelLiters > 0
              ? `${base} · ${formatNumber(t.fuelLiters)} L al cierre`
              : base,
          changes: null,
        });
      }
    }

    for (const r of reportes) {
      push({
        id: `report:created:${r.id}`,
        kind: 'DAILY_REPORT',
        action: 'CREATED',
        occurredAt: r.createdAt,
        dataDate: formatDateOnly(r.fecha),
        actorName: nombre(r.supervisorId) ?? r.supervisorNombre,
        summary: turnoLabel(r.turno),
        changes: null,
      });
    }

    for (const t of trabajos) {
      push({
        id: `extra:created:${t.id}`,
        kind: 'EXTRA_WORK',
        action: 'CREATED',
        occurredAt: t.createdAt,
        dataDate: businessDayKey(t.fecha),
        actorName: nombre(t.createdById),
        summary: `N° ${t.numero} · ${t.equipo.internalCode} · ${t.operador} · ${formatNumber(
          t.totalHoras,
        )} h`,
        changes: null,
      });
    }

    for (const h of hallazgos) {
      const donde =
        h.tipo === 'ZONA'
          ? [h.lugar, h.faena].filter(Boolean).join(' · ') || 'Zona'
          : (h.equipo?.internalCode ?? '—');
      push({
        id: `finding:created:${h.id}`,
        kind: 'FINDING',
        action: 'CREATED',
        occurredAt: h.createdAt,
        dataDate: businessDayKey(h.fecha),
        actorName: nombre(h.createdById),
        summary: `${donde} · ${h.descripcion}`,
        changes: null,
      });
    }

    for (const o of ordenes) {
      const codigo = codigoEquipo.get(o.equipoId);
      push({
        id: `ot:created:${o.id}`,
        kind: 'WORK_ORDER',
        action: 'CREATED',
        occurredAt: o.createdAt,
        dataDate: businessDayKey(o.createdAt),
        actorName: nombre(o.createdById),
        summary: codigo ? `${o.titulo} · ${codigo}` : o.titulo,
        changes: null,
      });
    }

    for (const i of intervenciones) {
      const codigo = i.orden ? codigoEquipo.get(i.orden.equipoId) : undefined;
      const titulo = i.orden?.titulo ?? i.detalle;
      push({
        id: `ot:closed:${i.id}`,
        kind: 'WORK_ORDER',
        action: 'CLOSED',
        occurredAt: i.fecha,
        dataDate: businessDayKey(i.fecha),
        actorName: nombre(i.realizadaPorId) ?? nombre(i.createdById),
        summary: codigo ? `${titulo} · ${codigo}` : titulo,
        changes: null,
      });
    }

    for (const s of salidas) {
      push({
        id: `exit:created:${s.id}`,
        kind: 'EXIT_REPORT',
        action: 'CREATED',
        occurredAt: s.createdAt,
        dataDate: formatDateOnly(s.shift.date),
        actorName: nombre(s.createdById),
        summary: `${turnoLabel(s.shift.type)} · ${s.cardCount} ${
          s.cardCount === 1 ? 'tarjeta' : 'tarjetas'
        }`,
        changes: null,
      });
    }

    for (const c of cambios) {
      const entidad = ENTITY_KIND[c.entity] ?? {
        kind: 'OTHER' as const,
        label: c.entity,
      };
      const changes = c.changes as unknown as FieldChange[];
      push({
        id: `log:${c.id}`,
        kind: entidad.kind,
        action: c.action === 'DELETE' ? 'DELETED' : 'UPDATED',
        occurredAt: c.createdAt,
        // El historial no guarda el día de negocio del registro editado: acá
        // manda el cuándo se editó, sin segunda fecha.
        dataDate: null,
        actorName: c.userName,
        summary: `${entidad.label} · ${changes.length} ${
          changes.length === 1 ? 'dato' : 'datos'
        }`,
        changes,
      });
    }

    events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    return { from: desde, to: hasta, events };
  }
}
