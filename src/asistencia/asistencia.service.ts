import { BadRequestException, Injectable } from '@nestjs/common';

import { ROLES } from '../auth/roles';
import { businessDayKey } from '../common/dates/business-time';
import { PrismaService } from '../common/prisma/prisma.service';
import { formatDateOnly, parseDateOnlyUtc } from '../shifts/date-only';

export interface PersonaAsistencia {
  id: string;
  nombre: string;
  tipo: 'SUPERVISOR' | 'OPERADOR';
  /** Días del mes con X, ascendente (ej. `[1, 2, 6]`). */
  dias: number[];
  /** `dias.length` — el número que la secretaria copia a la liquidación. */
  total: number;
}

export interface AsistenciaMes {
  mes: string;
  /** Cantidad de días del mes (28–31). */
  dias: number;
  /** SUPERVISOR primero, luego OPERADOR; alfabético dentro del grupo. */
  personas: PersonaAsistencia[];
}

const MES_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Margen sobre la query por instante: absorbe el huso (Chile vs UTC) y el
 * nocturno; el día FINO se decide en memoria con `businessDayKey`/`Shift.date`
 * y se descarta lo que no cae en el mes. */
const MARGEN_MS = 48 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * La grilla de asistencia del mes («DIAS TRABAJO MES» del Excel de la
 * secretaria), 100 % derivada de los registros:
 * - X del SUPERVISOR: tarjetas de turno que ÉL registró (`supervisorId`), en
 *   el día del TURNO (`Shift.date`, o el día de negocio de `fecha` si la
 *   tarjeta no tiene turno). El cierre no genera X propia: contar «cerró»
 *   duplicaría el nocturno que cruza medianoche.
 * - X del OPERADOR: tarjetas (`operatorId`) en el día del turno, y Reports
 *   (`TrabajoExtraordinario.operatorId`) en el día de negocio de su `fecha`.
 * - Nunca se usa `createdAt`: un turno del 7 subido el 8 marca el 7 (pedido
 *   explícito del cliente).
 */
@Injectable()
export class AsistenciaService {
  constructor(private readonly prisma: PrismaService) {}

  async mes(mes: string): Promise<AsistenciaMes> {
    if (!MES_REGEX.test(mes)) {
      throw new BadRequestException('Mes inválido: se espera YYYY-MM');
    }
    const [anio, numeroMes] = mes.split('-').map(Number);
    const diasDelMes = new Date(Date.UTC(anio, numeroMes, 0)).getUTCDate();
    const desde = parseDateOnlyUtc(`${mes}-01`);
    const hasta = parseDateOnlyUtc(
      `${mes}-${String(diasDelMes).padStart(2, '0')}`,
    );
    const margenDesde = new Date(desde.getTime() - MARGEN_MS);
    const margenHasta = new Date(hasta.getTime() + DIA_MS + MARGEN_MS);

    const [tarjetas, reports] = await Promise.all([
      this.prisma.registroHorometro.findMany({
        where: {
          OR: [
            { shift: { date: { gte: desde, lte: hasta } } },
            { shiftId: null, fecha: { gte: margenDesde, lte: margenHasta } },
          ],
        },
        select: {
          supervisorId: true,
          operatorId: true,
          fecha: true,
          shift: { select: { date: true } },
        },
      }),
      this.prisma.trabajoExtraordinario.findMany({
        where: { fecha: { gte: margenDesde, lte: margenHasta } },
        select: { operatorId: true, fecha: true },
      }),
    ]);

    // `Map<personaId, Set<díaDelMes>>`
    const diasSupervisor = new Map<string, Set<number>>();
    const diasOperador = new Map<string, Set<number>>();
    const marcar = (
      mapa: Map<string, Set<number>>,
      id: string | null | undefined,
      ymd: string,
    ) => {
      if (!id || !ymd.startsWith(`${mes}-`)) return;
      const diaDelMes = Number(ymd.slice(8));
      const set = mapa.get(id) ?? new Set<number>();
      set.add(diaDelMes);
      mapa.set(id, set);
    };

    for (const t of tarjetas) {
      // Día del TURNO; una tarjeta sin turno cae al día de negocio de su
      // `fecha` (zona de Chile, no UTC).
      const ymd = t.shift
        ? formatDateOnly(t.shift.date)
        : businessDayKey(t.fecha);
      marcar(diasSupervisor, t.supervisorId, ymd);
      marcar(diasOperador, t.operatorId, ymd);
    }
    for (const r of reports) {
      marcar(diasOperador, r.operatorId, businessDayKey(r.fecha));
    }

    // Roster de supervisores: todos los de rol SUPERVISOR, más cualquier id
    // con X (para distinguir «rol distinto» —se excluye: Mi Camioneta de
    // mantenedores/prevencionistas— de «usuario eliminado» —se muestra—).
    const idsConX = [...diasSupervisor.keys()];
    const usuarios = await this.prisma.user.findMany({
      where: {
        OR: [{ role: ROLES.SUPERVISOR }, { id: { in: idsConX } }],
      },
      select: { id: true, name: true, role: true, banned: true },
    });
    const usuarioPorId = new Map(usuarios.map((u) => [u.id, u]));

    const supervisores: PersonaAsistencia[] = [];
    for (const u of usuarios) {
      if (u.role !== ROLES.SUPERVISOR) continue;
      const dias = [...(diasSupervisor.get(u.id) ?? [])].sort((a, b) => a - b);
      if (u.banned === true && dias.length === 0) continue;
      supervisores.push({
        id: u.id,
        nombre: u.name,
        tipo: 'SUPERVISOR',
        dias,
        total: dias.length,
      });
    }
    for (const id of diasSupervisor.keys()) {
      if (usuarioPorId.has(id)) continue; // supervisor vigente u otro rol (excluido)
      const dias = [...diasSupervisor.get(id)!].sort((a, b) => a - b);
      supervisores.push({
        id,
        nombre: '(usuario eliminado)',
        tipo: 'SUPERVISOR',
        dias,
        total: dias.length,
      });
    }

    const operadores: PersonaAsistencia[] = [];
    const catalogo = await this.prisma.operator.findMany({
      select: { id: true, name: true, isActive: true },
    });
    const operadorPorId = new Map(catalogo.map((o) => [o.id, o]));
    for (const o of catalogo) {
      const dias = [...(diasOperador.get(o.id) ?? [])].sort((a, b) => a - b);
      if (!o.isActive && dias.length === 0) continue;
      operadores.push({
        id: o.id,
        nombre: o.name,
        tipo: 'OPERADOR',
        dias,
        total: dias.length,
      });
    }
    for (const id of diasOperador.keys()) {
      if (operadorPorId.has(id)) continue;
      const dias = [...diasOperador.get(id)!].sort((a, b) => a - b);
      operadores.push({
        id,
        nombre: '(operador eliminado)',
        tipo: 'OPERADOR',
        dias,
        total: dias.length,
      });
    }

    const porNombre = (a: PersonaAsistencia, b: PersonaAsistencia) =>
      a.nombre.localeCompare(b.nombre, 'es');
    supervisores.sort(porNombre);
    operadores.sort(porNombre);

    return {
      mes,
      dias: diasDelMes,
      personas: [...supervisores, ...operadores],
    };
  }
}
