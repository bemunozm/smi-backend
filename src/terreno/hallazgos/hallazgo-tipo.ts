/**
 * De qué es un hallazgo: de un EQUIPO (llega al taller) o de una ZONA de la
 * faena — un camino, una cancha, la romana — que no tiene máquina que reparar
 * y la atiende el administrador (pedido del cliente, 05/11).
 */
export const HALLAZGO_TIPOS = ['EQUIPO', 'ZONA'] as const;
export type HallazgoTipo = (typeof HALLAZGO_TIPOS)[number];

/** Las faenas de un hallazgo de zona — las mismas del Report. */
export const HALLAZGO_FAENAS = ['Patillo', 'Kainita'] as const;

/** Cómo se nombra el lugar de un hallazgo de zona: «Cancha norte (Kainita)». */
export function nombreZona(faena: string | null, lugar: string | null): string {
  return faena ? `${lugar ?? 'Zona'} (${faena})` : (lugar ?? 'Zona');
}
