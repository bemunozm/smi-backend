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

/** Límites UTC del día de negocio que contiene `ahora`: [00:00, 24:00) local. */
function limitesDeHoy(ahora = new Date()): { gte: Date; lt: Date } {
  const clave = businessDayKey(ahora); // 'YYYY-MM-DD' local
  // Ancla: medianoche local expresada en UTC. Chile es UTC-3/-4; sumar un
  // margen y re-derivar la clave evita depender del offset exacto:
  const base = new Date(`${clave}T00:00:00.000Z`);
  // Corrige el ancla hasta que su clave local sea `clave` (a lo más 1 paso):
  let gte = base;
  while (businessDayKey(gte) > clave) gte = new Date(gte.getTime() - 3_600_000);
  while (businessDayKey(gte) < clave) gte = new Date(gte.getTime() + 3_600_000);
  return { gte, lt: new Date(gte.getTime() + 24 * 3_600_000) };
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
