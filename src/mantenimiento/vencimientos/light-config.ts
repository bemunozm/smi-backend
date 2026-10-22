import type { EquipmentDocumentType, Prisma } from '@prisma/client';

import { DOCUMENT_EXPIRY_WARNING_DAYS } from '../../equipment/document-expiry';
import { LIGHT_SERVICE_ALERT_KM } from './vencimientos-rules';

/**
 * Configuración de mantención de un vehículo liviano (Módulo 4): con cuántos
 * km avisar antes de cada mantención de 10.000 km y con cuántos días avisar
 * antes de que venza cada papel. Decisión de Joaquín del 21/10: los livianos
 * no usan la pauta por hitos de los pesados.
 */
export interface LightConfig {
  serviceAlertKm: number;
  technicalInspectionAlertDays: number;
  circulationPermitAlertDays: number;
  insuranceAlertDays: number;
}

export const LIGHT_CONFIG_DEFAULTS: LightConfig = {
  serviceAlertKm: LIGHT_SERVICE_ALERT_KM,
  technicalInspectionAlertDays: DOCUMENT_EXPIRY_WARNING_DAYS,
  circulationPermitAlertDays: DOCUMENT_EXPIRY_WARNING_DAYS,
  insuranceAlertDays: DOCUMENT_EXPIRY_WARNING_DAYS,
};

/** Qué campo de la configuración fija el aviso de cada tipo de papel. */
export const LIGHT_DOC_ALERT_FIELD: Partial<
  Record<EquipmentDocumentType, keyof Omit<LightConfig, 'serviceAlertKm'>>
> = {
  TECHNICAL_INSPECTION: 'technicalInspectionAlertDays',
  CIRCULATION_PERMIT: 'circulationPermitAlertDays',
  INSURANCE: 'insuranceAlertDays',
};

type Lector = Pick<
  Prisma.TransactionClient,
  'equipment' | 'lightVehicleConfig'
>;

/** La configuración guardada del liviano, o la de defecto. */
export async function lightConfigOf(
  db: Pick<Prisma.TransactionClient, 'lightVehicleConfig'>,
  equipmentId: string,
): Promise<LightConfig> {
  const fila = await db.lightVehicleConfig.findUnique({
    where: { equipmentId },
  });
  return fila
    ? {
        serviceAlertKm: fila.serviceAlertKm,
        technicalInspectionAlertDays: fila.technicalInspectionAlertDays,
        circulationPermitAlertDays: fila.circulationPermitAlertDays,
        insuranceAlertDays: fila.insuranceAlertDays,
      }
    : { ...LIGHT_CONFIG_DEFAULTS };
}

/**
 * Los días de aviso que manda la configuración del liviano para un papel de
 * ese tipo, o `null` si no aplica (equipo pesado, u otro tipo de documento):
 * entonces vale lo que trae el propio documento.
 */
export async function lightDocAlertDays(
  db: Lector,
  equipmentId: string,
  type: EquipmentDocumentType,
): Promise<number | null> {
  const campo = LIGHT_DOC_ALERT_FIELD[type];
  if (!campo) return null;
  const equipo = await db.equipment.findUnique({
    where: { id: equipmentId },
    select: { equipmentClass: true },
  });
  if (equipo?.equipmentClass !== 'LIGHT') return null;
  return (await lightConfigOf(db, equipmentId))[campo];
}
