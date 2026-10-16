import { Injectable } from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { businessDayKey } from '../common/dates/business-time';
import { parseDateOnlyUtc } from '../shifts/date-only';
import { DashboardRangeDto } from './dto/dashboard-range.dto';

export type EstadoEquipoHoy = {
  equipmentId: string;
  internalCode: string;
  estado: 'EN_USO' | 'DISPONIBLE' | 'INOPERATIVO';
  operador?: string;
  turno?: string;
  supervisor?: string;
};

export type ResumenHoy = {
  totales: { enUso: number; disponibles: number; inoperativos: number };
  equipos: EstadoEquipoHoy[];
};

export type MetricasEquipo = {
  equipmentId: string;
  internalCode: string;
  horas: number;
  litros: number;
  rendimiento: number | null;
  serieDiaria: { fecha: string; horas: number; opero: boolean }[];
};

const SIN_ASIGNAR = '(sin asignar)';

const round2 = (n: number) => Number(n.toFixed(2));

/** Primer instante UTC cuya clave de día de negocio es `clave` (medianoche local). */
function inicioDeDia(clave: string): Date {
  // Ancla en medianoche UTC y converge por horas hasta que la clave local
  // coincida (Chile va UTC-3/-4, así que a lo más ~4 pasos; no depende del
  // offset exacto ni del cambio de hora).
  let t = new Date(`${clave}T00:00:00.000Z`);
  while (businessDayKey(t) > clave) t = new Date(t.getTime() - 3_600_000);
  while (businessDayKey(t) < clave) t = new Date(t.getTime() + 3_600_000);
  return t;
}

/** Límites UTC del día de negocio que contiene `ahora`: [00:00, 24:00) local.
 * `lt` es la medianoche local del día SIGUIENTE (no gte + 24h): los días de
 * cambio de hora duran 23h o 25h. */
export function limitesDeHoy(ahora = new Date()): { gte: Date; lt: Date } {
  const clave = businessDayKey(ahora); // 'YYYY-MM-DD' local
  const siguiente = new Date(`${clave}T00:00:00.000Z`);
  siguiente.setUTCDate(siguiente.getUTCDate() + 1);
  return {
    gte: inicioDeDia(clave),
    lt: inicioDeDia(siguiente.toISOString().slice(0, 10)),
  };
}

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async hoy(): Promise<ResumenHoy> {
    const [equipos, abiertas] = await Promise.all([
      this.prisma.equipment.findMany({
        select: { id: true, internalCode: true, status: true },
        orderBy: { internalCode: 'asc' },
      }),
      this.prisma.registroHorometro.findMany({
        where: { valorFinal: null, fecha: limitesDeHoy() },
        select: { equipoId: true, operador: true, turno: true, supervisorId: true },
        // Ascendente: en el Map, la última fila (la más reciente) gana.
        orderBy: { fecha: 'asc' },
      }),
    ]);

    const supervisores = await this.nombresDe(
      abiertas.map((a) => a.supervisorId),
    );
    const porEquipo = new Map(abiertas.map((a) => [a.equipoId, a]));

    const lista: EstadoEquipoHoy[] = equipos.map((e) => {
      const tarjeta = porEquipo.get(e.id);
      if (tarjeta) {
        return {
          equipmentId: e.id,
          internalCode: e.internalCode,
          estado: 'EN_USO',
          operador: tarjeta.operador,
          turno: tarjeta.turno,
          supervisor: supervisores.get(tarjeta.supervisorId ?? '') ?? SIN_ASIGNAR,
        };
      }
      return {
        equipmentId: e.id,
        internalCode: e.internalCode,
        estado: e.status === 'OPERATIONAL' ? 'DISPONIBLE' : 'INOPERATIVO',
      };
    });

    return {
      totales: {
        enUso: lista.filter((x) => x.estado === 'EN_USO').length,
        disponibles: lista.filter((x) => x.estado === 'DISPONIBLE').length,
        inoperativos: lista.filter((x) => x.estado === 'INOPERATIVO').length,
      },
      equipos: lista,
    };
  }

  async equipos(q: DashboardRangeDto): Promise<MetricasEquipo[]> {
    const { desde, hasta, dias } = this.resolverRango(q);
    const diasSet = new Set(dias);

    const [equipos, tarjetas, cargas] = await Promise.all([
      this.prisma.equipment.findMany({
        select: { id: true, internalCode: true },
        orderBy: { internalCode: 'asc' },
      }),
      dias.length === 0
        ? Promise.resolve([])
        : this.prisma.registroHorometro.findMany({
            where: { valorFinal: { not: null }, fecha: { gte: desde, lte: hasta } },
            select: { equipoId: true, valorInicial: true, valorFinal: true, fecha: true },
          }),
      dias.length === 0
        ? Promise.resolve([])
        : this.prisma.registroCombustible.findMany({
            where: { fecha: { gte: desde, lte: hasta } },
            select: { equipoId: true, litros: true, fecha: true },
          }),
    ]);

    // horas por equipo+día, solo días dentro del rango de negocio
    const horasPorEquipoDia = new Map<string, Map<string, number>>();
    for (const t of tarjetas) {
      const dia = businessDayKey(t.fecha);
      if (!diasSet.has(dia)) continue;
      const delta = (t.valorFinal as number) - t.valorInicial;
      const porDia = horasPorEquipoDia.get(t.equipoId) ?? new Map<string, number>();
      porDia.set(dia, (porDia.get(dia) ?? 0) + delta);
      horasPorEquipoDia.set(t.equipoId, porDia);
    }
    const litrosPorEquipo = new Map<string, number>();
    for (const c of cargas) {
      // La ventana SQL va ampliada: recortar al día de negocio como las tarjetas.
      if (!diasSet.has(businessDayKey(c.fecha))) continue;
      litrosPorEquipo.set(c.equipoId, (litrosPorEquipo.get(c.equipoId) ?? 0) + c.litros);
    }

    return equipos.map((e) => {
      const porDia = horasPorEquipoDia.get(e.id) ?? new Map<string, number>();
      const serieDiaria = dias.map((fecha) => {
        const horas = round2(porDia.get(fecha) ?? 0);
        return { fecha, horas, opero: porDia.has(fecha) };
      });
      const horas = round2([...porDia.values()].reduce((a, b) => a + b, 0));
      const litros = round2(litrosPorEquipo.get(e.id) ?? 0);
      return {
        equipmentId: e.id,
        internalCode: e.internalCode,
        horas,
        litros,
        rendimiento: horas > 0 ? round2(litros / horas) : null,
        serieDiaria,
      };
    });
  }

  /** Rango resuelto: default mes actual; días como claves de negocio. */
  private resolverRango(q: { desde?: string; hasta?: string }): {
    desde: Date; // ampliado −12h, para columnas timestamp
    hasta: Date; // ampliado +36h, para columnas timestamp
    desdeDia: Date; // sin ampliar, para columnas @db.Date
    hastaDia: Date; // sin ampliar, para columnas @db.Date
    dias: string[];
  } {
    const hoy = businessDayKey(new Date()); // 'YYYY-MM-DD'
    const desdeStr = q.desde ?? `${hoy.slice(0, 7)}-01`;
    const hastaStr = q.hasta ?? hoy;
    const desde = parseDateOnlyUtc(desdeStr);
    const hasta = parseDateOnlyUtc(hastaStr);
    const dias: string[] = [];
    for (let d = new Date(desde); d <= hasta; d = new Date(d.getTime() + 86_400_000)) {
      dias.push(d.toISOString().slice(0, 10)); // claves date-only UTC == claves de negocio para dias enteros
    }
    // El filtro SQL va en UTC amplio y el ajuste fino lo hace businessDayKey al
    // agrupar: ampliar medio día a cada lado evita perder bordes. Las columnas
    // @db.Date (Shift.date, ReporteDiario.fecha) usan los límites SIN ampliar
    // (`desdeDia`/`hastaDia`), porque ahí no hay hora que corregir.
    return {
      desde: new Date(desde.getTime() - 12 * 3_600_000),
      hasta: new Date(hasta.getTime() + 36 * 3_600_000),
      desdeDia: desde,
      hastaDia: hasta,
      dias,
    };
  }

  /** Resuelve soft refs a `user.name` en UNA consulta. */
  private async nombresDe(ids: (string | null)[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter((x): x is string => x != null))];
    if (unicos.length === 0) return new Map();
    const usuarios = await this.prisma.user.findMany({
      where: { id: { in: unicos } },
      select: { id: true, name: true },
    });
    return new Map(usuarios.map((u) => [u.id, u.name]));
  }
}
