import { Prisma } from '@prisma/client';

/**
 * Tablas cuyas filas se pueden bloquear con `lockRow`. Mapa cerrado a
 * propósito: el nombre real de la tabla (`@@map`) se interpola como
 * identificador SQL, y eso nunca puede salir de un input.
 */
const LOCKABLE_TABLES = {
  equipment: 'equipment',
  equipmentDocument: 'equipment_document',
  inventoryItem: 'inventory_item',
  itemCategory: 'item_category',
  branch: 'branch',
  operator: 'operator',
  ordenTrabajo: 'orden_trabajo',
  actividad: 'actividad',
  registroHorometro: 'RegistroHorometro',
  hallazgo: 'Hallazgo',
  trabajoExtra: 'TrabajoExtraordinario',
} as const;

export type LockableTable = keyof typeof LOCKABLE_TABLES;

/**
 * `SELECT ... FOR UPDATE` de una fila dentro de una transacción: quien edita
 * después espera a que esta termine y lee ya el valor vigente, que es lo que
 * necesita una precondición por campo (`assertExpected`) para no comparar
 * contra un dato viejo.
 *
 * Devuelve `false` si la fila no existe (el caller decide el 404).
 */
export async function lockRow(
  tx: Prisma.TransactionClient,
  table: LockableTable,
  id: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM ${Prisma.raw(`"${LOCKABLE_TABLES[table]}"`)} WHERE id = ${id} FOR UPDATE`,
  );
  return rows.length > 0;
}
