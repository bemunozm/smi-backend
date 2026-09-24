import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Actividad,
  Hallazgo,
  Intervencion,
  OrdenTrabajo,
  RegistroCombustible,
  RegistroHorometro,
  TrabajoExtraordinario,
} from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { EventoFicha, FichaEquipo, ResumenFicha } from './dto/ficha.dto';

const LIMITE_POR_ORIGEN = 50;

type OrdenTrabajoConIntervenciones = OrdenTrabajo & {
  intervenciones: Intervencion[];
};

/**
 * Agregador de Núcleo para la ficha consolidada de un equipo (requerimientos
 * §5.5). Terreno y Mantenimiento NO tienen relación Prisma con `Equipment` (usan
 * `equipoId` como soft-ref), así que este servicio consulta cada tabla de
 * forma independiente vía `PrismaService` y normaliza el resultado a un único
 * timeline — no reemplaza ni modifica los módulos de cada dominio.
 */
@Injectable()
export class FichaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async getFichaEquipo(id: string): Promise<FichaEquipo> {
    const [
      equipo,
      combustibles,
      horometros,
      trabajosExtra,
      hallazgos,
      ordenes,
      actividades,
      combustiblesCount,
      horometrosCount,
      trabajosExtraCount,
      hallazgosCount,
      hallazgosAbiertosCount,
      ordenesCount,
      ordenesAbiertasCount,
      actividadesCount,
    ] = await Promise.all([
      this.prisma.equipment.findUnique({
        where: { id },
        select: {
          id: true,
          internalCode: true,
          type: true,
          brand: true,
          model: true,
          year: true,
          status: true,
          currentHourmeter: true,
          currentMileage: true,
        },
      }),
      this.prisma.registroCombustible.findMany({
        where: { equipoId: id },
        orderBy: { fecha: 'desc' },
        take: LIMITE_POR_ORIGEN,
      }),
      this.prisma.registroHorometro.findMany({
        where: { equipoId: id },
        orderBy: { fecha: 'desc' },
        take: LIMITE_POR_ORIGEN,
      }),
      this.prisma.trabajoExtraordinario.findMany({
        where: { equipoId: id },
        orderBy: { fecha: 'desc' },
        take: LIMITE_POR_ORIGEN,
      }),
      this.prisma.hallazgo.findMany({
        where: { equipoId: id },
        orderBy: { fecha: 'desc' },
        take: LIMITE_POR_ORIGEN,
      }),
      this.prisma.ordenTrabajo.findMany({
        where: { equipoId: id },
        include: {
          intervenciones: {
            orderBy: { fecha: 'desc' },
            take: LIMITE_POR_ORIGEN,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: LIMITE_POR_ORIGEN,
      }),
      this.prisma.actividad.findMany({
        where: { equipoId: id },
        orderBy: { createdAt: 'desc' },
        take: LIMITE_POR_ORIGEN,
      }),
      this.prisma.registroCombustible.count({ where: { equipoId: id } }),
      this.prisma.registroHorometro.count({ where: { equipoId: id } }),
      this.prisma.trabajoExtraordinario.count({ where: { equipoId: id } }),
      this.prisma.hallazgo.count({ where: { equipoId: id } }),
      this.prisma.hallazgo.count({
        where: { equipoId: id, estado: { not: 'CERRADO' } },
      }),
      this.prisma.ordenTrabajo.count({ where: { equipoId: id } }),
      this.prisma.ordenTrabajo.count({
        where: {
          equipoId: id,
          estado: { notIn: ['COMPLETADA', 'CANCELADA'] },
        },
      }),
      this.prisma.actividad.count({ where: { equipoId: id } }),
    ]);

    if (!equipo) throw new NotFoundException(`Equipo "${id}" no encontrado`);

    // Firmas resueltas ANTES de mapear (ver Diseño del RFC R2-storage,
    // "Combustible"): `mapCombustible` se mantiene síncrono, consumiendo el
    // mapa ya resuelto — mismo patrón batch que `EquipmentService.resolvePhotoUrls`.
    const fotoUrlsPorCombustible =
      await this.resolveCombustibleFotoUrls(combustibles);

    const eventosOrdenes = ordenes.map((ot) => this.mapOrden(ot));
    const eventosIntervenciones = ordenes.flatMap((ot) =>
      ot.intervenciones.map((intervencion) =>
        this.mapIntervencion(intervencion, ot),
      ),
    );

    const timeline: EventoFicha[] = [
      ...combustibles.map((r) =>
        this.mapCombustible(r, fotoUrlsPorCombustible.get(r.id) ?? null),
      ),
      ...horometros.map((r) => this.mapHorometro(r)),
      ...trabajosExtra.map((r) => this.mapTrabajoExtra(r)),
      ...hallazgos.map((r) => this.mapHallazgo(r)),
      ...eventosOrdenes,
      ...eventosIntervenciones,
      ...actividades.map((r) => this.mapActividad(r)),
    ].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());

    const resumen: ResumenFicha = {
      combustibles: combustiblesCount,
      horometros: horometrosCount,
      trabajosExtra: trabajosExtraCount,
      hallazgos: hallazgosCount,
      hallazgosAbiertos: hallazgosAbiertosCount,
      ordenes: ordenesCount,
      ordenesAbiertas: ordenesAbiertasCount,
      actividades: actividadesCount,
    };

    return { equipo, resumen, timeline };
  }

  /** `fotoUrl` YA resuelta por `resolveCombustibleFotoUrls` — este método se
   * mantiene síncrono a propósito (ver docstring de `getFichaEquipo`). */
  private mapCombustible(
    registro: RegistroCombustible,
    fotoUrl: string | null,
  ): EventoFicha {
    return {
      id: registro.id,
      tipo: 'COMBUSTIBLE',
      fecha: registro.fecha.toISOString(),
      titulo: `Carga de combustible ${registro.litros} L`,
      detalle: `Tipo: ${registro.tipo}`,
      meta: {
        litros: registro.litros,
        tipo: registro.tipo,
        fotoUrl,
      },
    };
  }

  /**
   * `fotoUrl` de cada combustible, en UNA tanda `Promise.all`: firmada si el
   * registro tiene `fotoKey` (subida nueva por R2/MinIO), o el valor legacy
   * `fotoUrl` tal cual si no (subida vieja por `/api/uploads`, Terreno sigue
   * usándola) — mismo criterio que `CombustibleService.shape`.
   */
  private async resolveCombustibleFotoUrls(
    combustibles: readonly RegistroCombustible[],
  ): Promise<ReadonlyMap<string, string | null>> {
    const entradas = await Promise.all(
      combustibles.map(async (registro) => {
        const fotoUrl = registro.fotoKey
          ? await this.storage.sign(registro.fotoKey)
          : registro.fotoUrl;
        return [registro.id, fotoUrl] as const;
      }),
    );
    return new Map(entradas);
  }

  private mapHorometro(registro: RegistroHorometro): EventoFicha {
    return {
      id: registro.id,
      tipo: 'HOROMETRO',
      fecha: registro.fecha.toISOString(),
      titulo: `Registro de horómetro — turno ${registro.turno}`,
      detalle: `Operador: ${registro.operador}. Inicial: ${registro.valorInicial}${
        registro.valorFinal !== null ? `, final: ${registro.valorFinal}` : ''
      }`,
      meta: {
        operador: registro.operador,
        turno: registro.turno,
        valorInicial: registro.valorInicial,
        valorFinal: registro.valorFinal,
        nivelCombustible: registro.nivelCombustible,
        fotoUrl: registro.fotoUrl,
      },
    };
  }

  private mapTrabajoExtra(registro: TrabajoExtraordinario): EventoFicha {
    return {
      id: registro.id,
      tipo: 'TRABAJO_EXTRA',
      fecha: registro.fecha.toISOString(),
      titulo: `Trabajo extraordinario — ${registro.actividad}`,
      detalle: registro.descripcion,
      meta: {
        operador: registro.operador,
        faena: registro.faena,
        turno: registro.turno,
        horometroInicial: registro.horometroInicial,
        horometroFinal: registro.horometroFinal,
        totalHoras: registro.totalHoras,
        actividad: registro.actividad,
        observaciones: registro.observaciones,
      },
    };
  }

  private mapHallazgo(registro: Hallazgo): EventoFicha {
    const estadoLegible: Record<string, string> = {
      ABIERTO: 'abierto',
      EN_PROCESO: 'en proceso',
      CERRADO: 'cerrado',
    };

    return {
      id: registro.id,
      tipo: 'HALLAZGO',
      fecha: registro.fecha.toISOString(),
      titulo: `Hallazgo ${registro.prioridad} — ${
        estadoLegible[registro.estado] ?? registro.estado
      }`,
      detalle: registro.descripcion,
      meta: {
        prioridad: registro.prioridad,
        estado: registro.estado,
        fotoUrl: registro.fotoUrl,
      },
    };
  }

  private mapOrden(orden: OrdenTrabajoConIntervenciones): EventoFicha {
    return {
      id: orden.id,
      tipo: 'ORDEN_TRABAJO',
      fecha: orden.createdAt.toISOString(),
      titulo: `Orden de trabajo — ${orden.titulo}`,
      detalle: `${orden.tipo} · origen: ${orden.origen}${
        orden.origenDetalle ? ` (${orden.origenDetalle})` : ''
      }`,
      meta: {
        estado: orden.estado,
        prioridad: orden.prioridad,
        tipo: orden.tipo,
        origen: orden.origen,
      },
    };
  }

  private mapIntervencion(
    intervencion: Intervencion,
    orden: OrdenTrabajo,
  ): EventoFicha {
    return {
      id: intervencion.id,
      tipo: 'INTERVENCION',
      fecha: intervencion.fecha.toISOString(),
      titulo: `Intervención en OT "${orden.titulo}"`,
      detalle: intervencion.detalle,
      meta: {
        ordenId: intervencion.ordenId,
        tipo: intervencion.tipo,
        horasHombre: intervencion.horasHombre,
        horometro: intervencion.horometro,
        soloLectura: intervencion.soloLectura,
      },
    };
  }

  private mapActividad(registro: Actividad): EventoFicha {
    return {
      id: registro.id,
      tipo: 'ACTIVIDAD',
      fecha: registro.createdAt.toISOString(),
      titulo: `Actividad — ${registro.origen}`,
      detalle: registro.descripcion,
      meta: {
        origen: registro.origen,
        estado: registro.estado,
        referencia: registro.referencia,
        hallazgoId: registro.hallazgoId,
      },
    };
  }
}
