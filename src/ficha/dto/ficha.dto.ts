import { EquipmentStatus } from '@prisma/client';

/**
 * Tipos de origen de un evento en la línea de tiempo consolidada. Uno por
 * cada dominio que aporta historial a la ficha del equipo.
 */
export type TipoEventoFicha =
  | 'COMBUSTIBLE'
  | 'HOROMETRO'
  | 'TRABAJO_EXTRA'
  | 'HALLAZGO'
  | 'ORDEN_TRABAJO'
  | 'INTERVENCION'
  | 'ACTIVIDAD';

/** Evento normalizado de la línea de tiempo, sin importar su dominio de origen. */
export interface EventoFicha {
  id: string;
  tipo: TipoEventoFicha;
  /** ISO 8601. */
  fecha: string;
  titulo: string;
  detalle: string;
  /** Campos específicos del dominio de origen, para que el front los muestre sin volver a consultar. */
  meta: Record<string, string | number | boolean | null>;
}

/**
 * Subconjunto de `Equipment` que se muestra en el encabezado de la ficha.
 * Campos en inglés porque siguen 1:1 los nombres reales del modelo `Equipment`
 * (Flota, RFC T01) — el resto de la ficha (Terreno/Mantenimiento) sigue en
 * español, dominio de sus dueños.
 */
export interface EquipoFichaResumen {
  id: string;
  internalCode: string;
  type: string;
  brand: string;
  model: string;
  year: number | null;
  status: EquipmentStatus;
  currentHourmeter: number | null;
  currentMileage: number | null;
}

/** Contadores agregados de la ficha, para tarjetas/KPIs del front. */
export interface ResumenFicha {
  combustibles: number;
  horometros: number;
  trabajosExtra: number;
  hallazgos: number;
  /** Hallazgos con `estado !== 'CERRADO'` (ABIERTO o EN_PROCESO). */
  hallazgosAbiertos: number;
  ordenes: number;
  /** Órdenes con `estado` distinto de COMPLETADA y CANCELADA. */
  ordenesAbiertas: number;
  actividades: number;
}

/** Forma completa devuelta por `GET /api/equipos/:id/ficha`. */
export interface FichaEquipo {
  equipo: EquipoFichaResumen;
  resumen: ResumenFicha;
  timeline: EventoFicha[];
}
