import { Injectable } from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { businessDayKey } from '../common/dates/business-time';
import { parseDateOnlyUtc } from '../shifts/date-only';
import { DashboardRangeDto } from './dto/dashboard-range.dto';
import { SECCIONES } from '../terreno/reporte-diario/dto/create-reporte-diario.dto';

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

export type MetricasSupervisores = {
  porTurno: Record<'DIURNO' | 'NOCTURNO', { horas: number; equipos: number }>;
  porSupervisor: {
    supervisorId: string;
    nombre: string;
    horas: number;
    equipos: number;
    turnos: number;
  }[];
};

export type MetricasMantenedores = {
  total: { horas: number; trabajos: number };
  porEquipo: {
    equipmentId: string;
    internalCode: string;
    horas: number;
    trabajos: number;
  }[];
};

export type MetricasVueltas = {
  porSeccion: {
    seccion: string;
    camiones: number;
    vueltasTotales: number;
    serieDiaria: { fecha: string; vueltas: number }[];
  }[];
};

export type ResumenDia = {
  fecha: string;
  hm: { total: number; dia: number; noche: number };
  diesel: {
    total: number;
    dia: number;
    noche: number;
    porHm: number | null;
  };
  reports: {
    totalHoras: number;
    porEquipo: { internalCode: string; horas: number }[];
  };
  produccion: { internos: number; minaCaleta: number; mineras: number };
  adBlue: {
    itemId: string;
    nombre: string;
    stock: number;
    unidad: string;
  } | null;
  operacionPorEquipo: {
    internalCode: string;
    dia: { hm: number; litros: number };
    noche: { hm: number; litros: number };
    total: { hm: number; litros: number };
  }[];
  lecturas: {
    internalCode: string;
    turno: string;
    inicial: number;
    final: number | null;
    avance: number | null;
  }[];
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
        select: {
          equipoId: true,
          operador: true,
          turno: true,
          supervisorId: true,
        },
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
          supervisor:
            supervisores.get(tarjeta.supervisorId ?? '') ?? SIN_ASIGNAR,
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
            where: {
              valorFinal: { not: null },
              fecha: { gte: desde, lte: hasta },
            },
            select: {
              equipoId: true,
              valorInicial: true,
              valorFinal: true,
              fecha: true,
            },
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
      const porDia =
        horasPorEquipoDia.get(t.equipoId) ?? new Map<string, number>();
      porDia.set(dia, (porDia.get(dia) ?? 0) + delta);
      horasPorEquipoDia.set(t.equipoId, porDia);
    }
    const litrosPorEquipo = new Map<string, number>();
    for (const c of cargas) {
      // La ventana SQL va ampliada: recortar al día de negocio como las tarjetas.
      if (!diasSet.has(businessDayKey(c.fecha))) continue;
      litrosPorEquipo.set(
        c.equipoId,
        (litrosPorEquipo.get(c.equipoId) ?? 0) + c.litros,
      );
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

  async supervisores(q: DashboardRangeDto): Promise<MetricasSupervisores> {
    const { desde, hasta, desdeDia, hastaDia, dias } = this.resolverRango(q);
    const diasSet = new Set(dias);

    const [tarjetas, turnosRows] = await Promise.all([
      dias.length === 0
        ? Promise.resolve([])
        : this.prisma.registroHorometro.findMany({
            where: {
              valorFinal: { not: null },
              fecha: { gte: desde, lte: hasta },
            },
            select: {
              equipoId: true,
              turno: true,
              supervisorId: true,
              valorInicial: true,
              valorFinal: true,
              fecha: true,
            },
          }),
      dias.length === 0
        ? Promise.resolve([])
        : this.prisma.shift.findMany({
            where: { date: { gte: desdeDia, lte: hastaDia } },
            select: { supervisorId: true },
          }),
    ]);

    const turnoAcc = {
      DIURNO: { horas: 0, equipos: new Set<string>() },
      NOCTURNO: { horas: 0, equipos: new Set<string>() },
    };
    const supAcc = new Map<string, { horas: number; equipos: Set<string> }>();
    for (const t of tarjetas) {
      // Ventana SQL ampliada: recortar al día de negocio.
      if (!diasSet.has(businessDayKey(t.fecha))) continue;
      const delta = (t.valorFinal as number) - t.valorInicial;
      const clave = t.turno === 'NOCTURNO' ? 'NOCTURNO' : 'DIURNO';
      turnoAcc[clave].horas += delta;
      turnoAcc[clave].equipos.add(t.equipoId);
      const sid = t.supervisorId ?? '';
      const acc = supAcc.get(sid) ?? { horas: 0, equipos: new Set<string>() };
      acc.horas += delta;
      acc.equipos.add(t.equipoId);
      supAcc.set(sid, acc);
    }

    const turnosPorSup = new Map<string, number>();
    for (const s of turnosRows) {
      if (!s.supervisorId) continue;
      turnosPorSup.set(
        s.supervisorId,
        (turnosPorSup.get(s.supervisorId) ?? 0) + 1,
      );
    }

    const nombres = await this.nombresDe([...supAcc.keys()]);
    const porSupervisor = [...supAcc.entries()]
      .map(([supervisorId, a]) => ({
        supervisorId,
        nombre: nombres.get(supervisorId) ?? SIN_ASIGNAR,
        horas: round2(a.horas),
        equipos: a.equipos.size,
        turnos: turnosPorSup.get(supervisorId) ?? 0,
      }))
      .sort((a, b) => b.horas - a.horas);

    return {
      porTurno: {
        DIURNO: {
          horas: round2(turnoAcc.DIURNO.horas),
          equipos: turnoAcc.DIURNO.equipos.size,
        },
        NOCTURNO: {
          horas: round2(turnoAcc.NOCTURNO.horas),
          equipos: turnoAcc.NOCTURNO.equipos.size,
        },
      },
      porSupervisor,
    };
  }

  async mantenedores(q: DashboardRangeDto): Promise<MetricasMantenedores> {
    const { desde, hasta, dias } = this.resolverRango(q);
    const diasSet = new Set(dias);

    const trabajos =
      dias.length === 0
        ? []
        : await this.prisma.trabajoExtraordinario.findMany({
            where: { fecha: { gte: desde, lte: hasta } },
            select: {
              equipoId: true,
              totalHoras: true,
              fecha: true,
              equipo: { select: { internalCode: true } },
            },
          });

    const porEquipo = new Map<
      string,
      { internalCode: string; horas: number; trabajos: number }
    >();
    let horasTotal = 0;
    let trabajosTotal = 0;
    for (const t of trabajos) {
      if (!diasSet.has(businessDayKey(t.fecha))) continue;
      const horas = t.totalHoras ?? 0;
      const acc = porEquipo.get(t.equipoId) ?? {
        internalCode: t.equipo.internalCode,
        horas: 0,
        trabajos: 0,
      };
      acc.horas += horas;
      acc.trabajos += 1;
      porEquipo.set(t.equipoId, acc);
      horasTotal += horas;
      trabajosTotal += 1;
    }

    return {
      total: { horas: round2(horasTotal), trabajos: trabajosTotal },
      porEquipo: [...porEquipo.entries()]
        .map(([equipmentId, a]) => ({
          equipmentId,
          internalCode: a.internalCode,
          horas: round2(a.horas),
          trabajos: a.trabajos,
        }))
        .sort((a, b) => b.horas - a.horas),
    };
  }

  /** Vueltas de producción por sección (camiones×vueltas), sin total general. */
  async vueltas(q: DashboardRangeDto): Promise<MetricasVueltas> {
    const { desdeDia, hastaDia } = this.resolverRango(q);

    // `ReporteDiario.fecha` es @db.Date: límites SIN ampliar, clave = fecha UTC.
    const filas = await this.prisma.produccionTurno.findMany({
      where: { reporte: { fecha: { gte: desdeDia, lte: hastaDia } } },
      select: {
        seccion: true,
        camiones: true,
        vueltasPorCamion: true,
        reporte: { select: { fecha: true } },
      },
    });

    type Acc = {
      camiones: number;
      vueltasTotales: number;
      porDia: Map<string, number>;
    };
    const acc = new Map<string, Acc>(
      SECCIONES.map((s): [string, Acc] => [
        s,
        { camiones: 0, vueltasTotales: 0, porDia: new Map() },
      ]),
    );
    for (const f of filas) {
      const a = acc.get(f.seccion);
      if (!a) continue;
      const vueltas = f.camiones * f.vueltasPorCamion;
      const dia = f.reporte.fecha.toISOString().slice(0, 10);
      a.camiones += f.camiones;
      a.vueltasTotales += vueltas;
      a.porDia.set(dia, (a.porDia.get(dia) ?? 0) + vueltas);
    }

    return {
      porSeccion: SECCIONES.map((seccion) => {
        const a = acc.get(seccion)!;
        return {
          seccion,
          camiones: a.camiones,
          vueltasTotales: a.vueltasTotales,
          serieDiaria: [...a.porDia.entries()]
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([fecha, vueltas]) => ({ fecha, vueltas })),
        };
      }),
    };
  }

  /** Portada del admin: resumen del día de negocio actual (solo lectura). */
  async resumenDia(): Promise<ResumenDia> {
    const ahora = new Date();
    const fecha = businessDayKey(ahora);
    const limites = limitesDeHoy(ahora);
    const ventana = {
      gte: new Date(limites.gte.getTime() - 12 * 3_600_000),
      lt: new Date(limites.lt.getTime() + 12 * 3_600_000),
    };

    const [tarjetas, cargas, trabajos, produccion, adBlue] = await Promise.all([
      // Tarjetas de hoy UNA vez (cerradas y abiertas); de aquí salen hm,
      // lecturas y operación por equipo.
      this.prisma.registroHorometro.findMany({
        where: { fecha: limites },
        select: {
          id: true,
          equipoId: true,
          turno: true,
          valorInicial: true,
          valorFinal: true,
          equipo: { select: { internalCode: true } },
        },
      }),
      this.prisma.registroCombustible.findMany({
        where: { fecha: ventana },
        select: {
          equipoId: true,
          litros: true,
          registroHorometroId: true,
          fecha: true,
          equipo: { select: { internalCode: true } },
        },
      }),
      this.prisma.trabajoExtraordinario.findMany({
        where: { fecha: ventana },
        select: {
          totalHoras: true,
          fecha: true,
          equipo: { select: { internalCode: true } },
        },
      }),
      // ReporteDiario.fecha es @db.Date: clave de hoy, sin ampliar.
      this.prisma.produccionTurno.findMany({
        where: { reporte: { fecha: parseDateOnlyUtc(fecha) } },
        select: { seccion: true, camiones: true, vueltasPorCamion: true },
      }),
      this.adBlueStock(),
    ]);

    type Op = {
      dia: { hm: number; litros: number };
      noche: { hm: number; litros: number };
      total: { hm: number; litros: number };
    };
    const ops = new Map<string, Op>();
    const opDe = (code: string): Op => {
      let o = ops.get(code);
      if (!o) {
        o = {
          dia: { hm: 0, litros: 0 },
          noche: { hm: 0, litros: 0 },
          total: { hm: 0, litros: 0 },
        };
        ops.set(code, o);
      }
      return o;
    };

    const hm = { total: 0, dia: 0, noche: 0 };
    const turnoDeTarjeta = new Map<string, string>();
    for (const t of tarjetas) {
      turnoDeTarjeta.set(t.id, t.turno);
      if (t.valorFinal == null) continue; // abierta: sin avance todavía
      const avance = t.valorFinal - t.valorInicial;
      const o = opDe(t.equipo.internalCode);
      const lado = t.turno === 'NOCTURNO' ? 'noche' : 'dia';
      hm.total += avance;
      hm[lado] += avance;
      o[lado].hm += avance;
      o.total.hm += avance;
    }

    const diesel = { total: 0, dia: 0, noche: 0 };
    for (const c of cargas) {
      // La ventana SQL va ampliada: recortar al día de negocio.
      if (businessDayKey(c.fecha) !== fecha) continue;
      const o = opDe(c.equipo.internalCode);
      diesel.total += c.litros;
      o.total.litros += c.litros;
      // Sin vínculo (o tarjeta fuera de hoy): solo suma al total.
      const turno = c.registroHorometroId
        ? turnoDeTarjeta.get(c.registroHorometroId)
        : undefined;
      if (turno) {
        const lado = turno === 'NOCTURNO' ? 'noche' : 'dia';
        diesel[lado] += c.litros;
        o[lado].litros += c.litros;
      }
    }

    const horasPorEquipo = new Map<string, number>();
    let totalHoras = 0;
    for (const t of trabajos) {
      if (businessDayKey(t.fecha) !== fecha) continue;
      const h = t.totalHoras ?? 0;
      totalHoras += h;
      horasPorEquipo.set(
        t.equipo.internalCode,
        (horasPorEquipo.get(t.equipo.internalCode) ?? 0) + h,
      );
    }

    const vueltas: Record<string, number> = {};
    for (const p of produccion) {
      vueltas[p.seccion] =
        (vueltas[p.seccion] ?? 0) + p.camiones * p.vueltasPorCamion;
    }

    const par = (x: { hm: number; litros: number }) => ({
      hm: round2(x.hm),
      litros: round2(x.litros),
    });

    return {
      fecha,
      hm: {
        total: round2(hm.total),
        dia: round2(hm.dia),
        noche: round2(hm.noche),
      },
      diesel: {
        total: round2(diesel.total),
        dia: round2(diesel.dia),
        noche: round2(diesel.noche),
        porHm: hm.total > 0 ? round2(diesel.total / hm.total) : null,
      },
      reports: {
        totalHoras: round2(totalHoras),
        porEquipo: [...horasPorEquipo.entries()]
          .map(([internalCode, h]) => ({ internalCode, horas: round2(h) }))
          .sort((a, b) => b.horas - a.horas),
      },
      produccion: {
        internos: vueltas['INTERNOS'] ?? 0,
        minaCaleta: vueltas['MINA_CALETA'] ?? 0,
        mineras: vueltas['MINERAS'] ?? 0,
      },
      adBlue,
      operacionPorEquipo: [...ops.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([internalCode, o]) => ({
          internalCode,
          dia: par(o.dia),
          noche: par(o.noche),
          total: par(o.total),
        })),
      lecturas: tarjetas
        .map((t) => ({
          internalCode: t.equipo.internalCode,
          turno: t.turno,
          inicial: t.valorInicial,
          final: t.valorFinal,
          avance:
            t.valorFinal == null ? null : round2(t.valorFinal - t.valorInicial),
        }))
        .sort(
          (a, b) =>
            a.internalCode.localeCompare(b.internalCode) ||
            a.turno.localeCompare(b.turno),
        ),
    };
  }

  /** Stock total del ítem AdBlue activo, o null si no existe en el catálogo. */
  private async adBlueStock(): Promise<ResumenDia['adBlue']> {
    // Dos findFirst en vez de un OR: se prefiere "adblue" y solo si no hay se
    // prueba "ad blue" (con espacio). Primero por nombre asc.
    for (const needle of ['adblue', 'ad blue']) {
      const item = await this.prisma.inventoryItem.findFirst({
        where: {
          isActive: true,
          name: { contains: needle, mode: 'insensitive' },
        },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          unit: true,
          stocks: { select: { quantity: true } },
        },
      });
      if (item) {
        return {
          itemId: item.id,
          nombre: item.name,
          stock: round2(item.stocks.reduce((a, s) => a + s.quantity, 0)),
          unidad: item.unit,
        };
      }
    }
    return null;
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
    for (
      let d = new Date(desde);
      d <= hasta;
      d = new Date(d.getTime() + 86_400_000)
    ) {
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
  private async nombresDe(
    ids: (string | null)[],
  ): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter((x): x is string => x != null))];
    if (unicos.length === 0) return new Map();
    const usuarios = await this.prisma.user.findMany({
      where: { id: { in: unicos } },
      select: { id: true, name: true },
    });
    return new Map(usuarios.map((u) => [u.id, u.name]));
  }
}
