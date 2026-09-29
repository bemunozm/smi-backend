import { ControlUnit, EquipmentClass } from '@prisma/client';

export interface EquipmentData {
  id: string;
  internalCode: string;
  [key: string]: unknown;
}

export interface OperatorData {
  id: string;
  name: string;
  isActive: boolean;
  [key: string]: unknown;
}

export interface CreateEquipmentPayload {
  internalCode: string;
  equipmentClass: EquipmentClass;
  type: string;
  brand: string;
  model: string;
  controlUnit: ControlUnit;
  [key: string]: unknown;
}

/** Payload mínimo válido de `POST /api/equipment` — mismo equipo base para
 * los tres e2e que crean equipos frescos (`shift-register`, `trabajos-extra`,
 * `equipment-assignment`); cada test solo varía `internalCode`. */
export function baseEquipmentPayload(
  internalCode: string,
): CreateEquipmentPayload {
  return {
    internalCode,
    equipmentClass: EquipmentClass.HEAVY,
    type: 'Excavadora',
    brand: 'Caterpillar',
    model: '320',
    controlUnit: ControlUnit.HOURS,
  };
}
