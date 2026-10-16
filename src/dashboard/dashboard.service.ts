import { Injectable } from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { businessDayKey } from '../common/dates/business-time';

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

const SIN_ASIGNAR = '(sin asignar)';

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
