/**
 * Reglas del checklist diario del mantenedor (Módulo 2 · R23 + R24). Función
 * pura: las aplica el servidor al recibir el envío, y la pantalla repite las
 * mismas para no ofrecer un «Enviar» que el servidor va a rechazar.
 *
 * Fotos (decisión de Joaquín, 16/10, en reemplazo del «≥ 60 % de lo declarado»
 * del Acta 006): la foto es obligatoria solo cuando a un ítem crítico se le
 * hizo mantención. Revisar un crítico (p. ej. «las pastillas se revisaron») no
 * pide foto, y en los demás ítems la foto es siempre opcional.
 */

export type EntryStatus = 'MAINTAINED' | 'CHECKED' | 'NOT_CHECKED';

export interface RuleItem {
  id: string;
  name: string;
  requiresPhoto: boolean;
  requiresTemperature: boolean;
}

export interface RuleEntry {
  itemId: string;
  status: EntryStatus;
  description?: string | null;
  temperature?: number | null;
  photoCount: number;
  supplyCount: number;
}

export interface ChecklistTally {
  /** Ítems declarados: «Se revisó» o «Se hizo mantención». */
  declared: number;
  /** Ítems con «Se hizo mantención». */
  maintained: number;
  /** Fotos adjuntas en todo el checklist. */
  photos: number;
}

/** Lo que se declaró y cuántas fotos trae. */
export function tally(entries: readonly RuleEntry[]): ChecklistTally {
  return {
    declared: entries.filter((e) => e.status !== 'NOT_CHECKED').length,
    maintained: entries.filter((e) => e.status === 'MAINTAINED').length,
    photos: entries.reduce((total, e) => total + e.photoCount, 0),
  };
}

/** ¿Este ítem, marcado así, tiene que llevar foto? */
export function needsPhoto(item: RuleItem, status: EntryStatus): boolean {
  return item.requiresPhoto && status === 'MAINTAINED';
}

/**
 * Los problemas que impiden enviar el checklist, en el orden en que conviene
 * mostrarlos. Vacío = se puede enviar.
 */
export function checklistProblems(
  catalog: readonly RuleItem[],
  entries: readonly RuleEntry[],
): string[] {
  const problemas: string[] = [];
  const porItem = new Map(catalog.map((i) => [i.id, i]));
  const vistos = new Set<string>();
  const sinFoto: string[] = [];

  for (const entry of entries) {
    const item = porItem.get(entry.itemId);
    if (!item) {
      problemas.push('El checklist trae un ítem que no está en el catálogo.');
      continue;
    }
    if (vistos.has(entry.itemId)) {
      problemas.push(`«${item.name}» viene dos veces.`);
      continue;
    }
    vistos.add(entry.itemId);

    const declarado = entry.status !== 'NOT_CHECKED';
    if (
      entry.status === 'MAINTAINED' &&
      (entry.description ?? '').trim().length < 3
    ) {
      problemas.push(`«${item.name}»: describe qué mantención se hizo.`);
    }
    if (entry.status !== 'MAINTAINED' && entry.supplyCount > 0) {
      problemas.push(
        `«${item.name}»: los insumos van solo con «Se hizo mantención».`,
      );
    }
    if (needsPhoto(item, entry.status) && entry.photoCount === 0) {
      sinFoto.push(item.name);
    }
    if (declarado && item.requiresTemperature && entry.temperature == null) {
      problemas.push(`«${item.name}»: anota la temperatura medida.`);
    }
  }

  if (sinFoto.length > 0) {
    problemas.push(
      `Falta la foto obligatoria de ${sinFoto.length === 1 ? 'la mantención de' : 'las mantenciones de'} ${sinFoto.map((n) => `«${n}»`).join(', ')}.`,
    );
  }

  const faltantes = catalog.filter((i) => !vistos.has(i.id));
  if (faltantes.length > 0) {
    problemas.push(
      `Faltan ${faltantes.length} ${faltantes.length === 1 ? 'ítem' : 'ítems'} por marcar: ${faltantes.map((i) => i.name).join(', ')}.`,
    );
  }

  if (tally(entries).declared === 0) {
    problemas.push(
      'No hay nada declarado: marca al menos un ítem como revisado o con mantención.',
    );
  }
  return problemas;
}
