import { EstadoEquipo } from '@prisma/client';

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

/** Subconjunto de `Equipo` que se muestra en el encabezado de la ficha. */
export interface EquipoFichaResumen {
  id: string;
  codigo: string;
  tipo: string;
  marca: string;
  modelo: string;
  anio: number | null;
  estado: EstadoEquipo;
  horometroActual: number;
  kilometrajeActual: number;
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
