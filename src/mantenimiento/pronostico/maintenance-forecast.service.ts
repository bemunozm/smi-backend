import { Injectable, NotFoundException } from '@nestjs/common';

import { todayInBusinessTimeZone } from '../../common/dates/business-time';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MaintenancePlansService } from '../maintenance-plans/maintenance-plans.service';
import {
  LIGHT_SERVICE_INTERVAL_KM,
  nextLightService,
} from '../vencimientos/vencimientos-rules';
import {
  dailyUsageRate,
  forecastMaintenance,
  PROFILE_WINDOW_DAYS,
  weekdayProfile,
  type Forecast,
  type UsageCard,
} from './usage-forecast';

const DIA_MS = 24 * 60 * 60 * 1000;

export interface MaintenanceForecastRow extends Forecast {
  equipmentId: string;
  /** Horas máquina (horómetro) en los pesados, km (odómetro) en los livianos. */
  unit: 'h' | 'km';
  /** De dónde sale la próxima mantención: la pauta o el ciclo de 10.000 km. */
  source: 'PAUTA' | 'LIVIANO';
  /** Contador en que toca (2.250 h, 30.000 km). */
  nextAt: number;
  /** Cuánto falta, en h o km. */
  remaining: number;
}

type Proxima = Pick<
  MaintenanceForecastRow,
  'equipmentId' | 'unit' | 'source' | 'nextAt' | 'remaining'
>;

const EQUIPO_SELECT = {
  id: true,
  equipmentClass: true,
  controlUnit: true,
  currentMileage: true,
} as const;

/**
 * Fecha estimada de la próxima mantención según el uso promedio (RFC
 * `docs/rfc/RFC-pronostico-mantencion.md`). Se calcula al pedirla, sobre las
 * lecturas de las tarjetas de turno: no guarda nada ni crea órdenes.
 */
@Injectable()
export class MaintenanceForecastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: MaintenancePlansService,
  ) {}

  /** Todos los equipos con próxima mantención conocida (pauta o liviano por km). */
  async forAll(now: Date = new Date()): Promise<MaintenanceForecastRow[]> {
    const equipos = await this.prisma.equipment.findMany({
      where: { status: { not: 'OUT_OF_SERVICE' } },
      select: EQUIPO_SELECT,
    });
    return this.calcular(equipos, now);
  }

  async forEquipment(
    equipmentId: string,
    now: Date = new Date(),
  ): Promise<MaintenanceForecastRow | null> {
    const equipo = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { ...EQUIPO_SELECT, status: true },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');
    if (equipo.status === 'OUT_OF_SERVICE') return null;
    const [fila] = await this.calcular([equipo], now);
    return fila ?? null;
  }

  private async calcular(
    equipos: {
      id: string;
      equipmentClass: string;
      controlUnit: string;
      currentMileage: number | null;
    }[],
    now: Date,
  ): Promise<MaintenanceForecastRow[]> {
    if (equipos.length === 0) return [];
    const pautas = new Map(
      (await this.plans.statusForAll()).map((p) => [p.equipmentId, p]),
    );

    // Lo que falta: la pauta manda; un liviano sin pauta va por el ciclo de 10.000 km.
    const proximas = equipos.flatMap((e): Proxima[] => {
      const pauta = pautas.get(e.id);
      if (pauta?.status.next) {
        const next = pauta.status.next;
        return [
          {
            equipmentId: e.id,
            unit: pauta.unit,
            source: 'PAUTA',
            nextAt: next.dueAt,
            remaining: next.remaining,
          },
        ];
      }
      if (pauta || e.equipmentClass !== 'LIGHT' || e.controlUnit !== 'KM')
        return [];
      const liviano = nextLightService(
        e.currentMileage,
        LIGHT_SERVICE_INTERVAL_KM,
      );
      if (!liviano) return [];
      return [
        {
          equipmentId: e.id,
          unit: 'km',
          source: 'LIVIANO',
          nextAt: liviano.nextKm,
          remaining: liviano.remainingKm,
        },
      ];
    });
    if (proximas.length === 0) return [];

    const tarjetas = await this.prisma.registroHorometro.findMany({
      where: {
        equipoId: { in: proximas.map((p) => p.equipmentId) },
        fecha: { gte: new Date(now.getTime() - PROFILE_WINDOW_DAYS * DIA_MS) },
      },
      select: {
        equipoId: true,
        fecha: true,
        valorInicial: true,
        fechaSalida: true,
        closedAt: true,
        valorFinal: true,
        belowPreviousReading: true,
      },
    });
    const porEquipo = new Map<string, UsageCard[]>();
    for (const t of tarjetas) {
      const lista = porEquipo.get(t.equipoId) ?? [];
      lista.push({
        start: t.fecha,
        initial: t.valorInicial,
        end: t.valorFinal == null ? null : (t.fechaSalida ?? t.closedAt),
        final: t.valorFinal,
        belowPrevious: t.belowPreviousReading,
      });
      porEquipo.set(t.equipoId, lista);
    }

    const today = todayInBusinessTimeZone(now);
    return proximas.map((p) => {
      const cards = porEquipo.get(p.equipmentId) ?? [];
      return {
        ...p,
        ...forecastMaintenance({
          remaining: p.remaining,
          rate: dailyUsageRate(cards, now),
          profile: weekdayProfile(cards, now, todayInBusinessTimeZone),
          today,
        }),
      };
    });
  }
}
