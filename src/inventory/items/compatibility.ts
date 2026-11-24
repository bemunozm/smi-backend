import type { Prisma } from '@prisma/client';

/**
 * Equipos asignados a un ítem (compatibilidad declarada), ordenados por código.
 * Va dentro del mismo `include` que las existencias: un solo viaje a la base,
 * sin N+1 en el listado.
 */
export const COMPATIBILITIES_INCLUDE = {
  compatibilities: {
    select: {
      equipmentId: true,
      note: true,
      equipment: { select: { internalCode: true } },
    },
    orderBy: { equipment: { internalCode: 'asc' } },
  },
} satisfies Prisma.InventoryItemInclude;

interface RawCompatibility {
  equipmentId: string;
  note: string | null;
  equipment: { internalCode: string };
}

export interface ItemEquipment {
  equipmentId: string;
  internalCode: string;
  note: string | null;
}

export function toItemEquipment(raw: RawCompatibility): ItemEquipment {
  return {
    equipmentId: raw.equipmentId,
    internalCode: raw.equipment.internalCode,
    note: raw.note,
  };
}

/** Aplana `compatibilities` al contrato público `{ equipmentId, internalCode, note }`. */
export function withEquipments<
  T extends { compatibilities: RawCompatibility[] },
>(item: T): Omit<T, 'compatibilities'> & { compatibilities: ItemEquipment[] } {
  // `?? []`: tolera un ítem armado a mano sin la relación (mocks de tests).
  return {
    ...item,
    compatibilities: (item.compatibilities ?? []).map(toItemEquipment),
  };
}
