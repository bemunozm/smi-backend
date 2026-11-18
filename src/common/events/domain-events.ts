/**
 * Contrato de eventos de dominio (Núcleo). Cada dominio (Terreno,
 * Mantenimiento, Inventario) emite estos eventos vía `EventEmitter2.emit(...)`
 * cuando corresponda. Este archivo solo define el contrato compartido:
 * nombre de evento + shape del payload, para que `NotificationsModule` (el
 * único consumidor) pueda escucharlos con `@OnEvent(...)` de forma tipada.
 *
 * Los payloads son deliberadamente livianos (ids + los campos mínimos para
 * armar un título/cuerpo de notificación) — si el listener necesita más
 * datos, se resuelven por su cuenta vía `PrismaService`, no infladando el
 * evento.
 */

export const DOMAIN_EVENTS = {
  HALLAZGO_CREATED: 'hallazgo.created',
  ORDEN_ASSIGNED: 'orden.assigned',
  ORDEN_COMPLETED: 'orden.completed',
  ITEM_LOW_STOCK: 'item.low-stock',
  SHIFT_EXIT_REPORT_SENT: 'shift.exit-report',
  RECORD_EDITED: 'record.edited',
  CHECKLIST_SUBMITTED: 'checklist.submitted',
  CHECKLIST_REVIEWED: 'checklist.reviewed',
  DOCUMENT_EXPIRING: 'document.expiring',
  LIGHT_SERVICE_DUE: 'light-service.due',
  PREVENTIVE_SERVICE_DUE: 'preventive-service.due',
  SHIFT_ENDED_WITH_OPEN_CARDS: 'shift.open-cards',
  FUEL_LOADED: 'fuel.loaded',
} as const;

export type DomainEventName =
  (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

/** Emitido por Terreno al crear un Hallazgo. */
export interface HallazgoCreatedEvent {
  hallazgoId: string;
  /** EQUIPO (va al taller) o ZONA (solo al administrador). Sin él, EQUIPO. */
  tipo?: 'EQUIPO' | 'ZONA';
  /** Solo ZONA: «Cancha norte (Kainita)». */
  zona?: string | null;
  equipoId?: string | null;
  /** Código del equipo (`CA-011`), para que el aviso diga qué máquina es. */
  equipoCodigo?: string | null;
  prioridad: string;
  descripcion: string;
}

/** Emitido por Mantenimiento al asignar una Orden de Trabajo. */
export interface OrdenAssignedEvent {
  ordenId: string;
  equipoId?: string | null;
  asignadoId?: string | null;
  titulo: string;
}

/** Emitido por Mantenimiento al completar una Orden de Trabajo. */
export interface OrdenCompletedEvent {
  ordenId: string;
  equipoId?: string | null;
  titulo: string;
}

/** Emitido por Inventario cuando un Insumo cruza su stockMinimo. */
export interface ItemLowStockEvent {
  itemId: string;
  itemName: string;
  /**
   * La alerta es POR BODEGA: con existencias por sucursal, avisar
   * "quedan 3" sin decir dónde no le sirve a nadie — el bodeguero no sabe si
   * le habla a él.
   */
  branchId: string;
  branchName: string;
  quantity: number;
  minimumQuantity: number;
}

/**
 * Emitido por `ShiftReportsService` DESPUÉS de
 * que la fila `ShiftExitReport` ya se confirmó en la base de
 * datos — nunca antes (ver `ShiftReportsService.create`). `fileKey` es la
 * key privada en el bucket (el listener la usa con
 * `StorageService.getObjectBuffer` para adjuntar el PDF al correo); nunca se
 * expone en una respuesta HTTP.
 */
export interface ShiftExitReportSentEvent {
  reportId: string;
  shiftId: string;
  fileKey: string;
  fileName: string;
  cardCount: number;
  /** Nombre del supervisor que generó el reporte (`session.user.name`). */
  supervisorName: string;
  /** `YYYY-MM-DD` — ver `src/shifts/date-only.ts`. */
  shiftDate: string;
  shiftType: string;
}

/**
 * Emitido al editar un registro ya enviado. La edición no pide autorización, pero el administrador se entera
 * de cada cambio: quién, sobre qué registro y qué dato pasó de qué a qué.
 */
export interface RecordEditedEvent {
  entity: string;
  entityId: string;
  /** Artículo con el que concuerda `entityLabel` («modificó el hallazgo», «modificó la tarjeta»). */
  entityArticle: 'el' | 'la';
  /** Cómo se nombra el registro en el aviso: `trabajo extra de CM-003 del 01-10-2026`. */
  entityLabel: string;
  editedBy: string;
  /** `true` cuando el registro se ELIMINÓ (el aviso dice «eliminó» y los
   * `changes` resumen lo borrado, con `after` en «—»). Sin él, edición. */
  deleted?: boolean;
  changes: { label: string; before: string; after: string }[];
}

/**
 * Emitido por Mantenimiento (Joaquín) al enviar el checklist diario de un
 * equipo (Módulo 2). Avisa al supervisor que tiene una revisión por validar
 * (Módulo 3).
 */
export interface ChecklistSubmittedEvent {
  checklistId: string;
  equipmentId: string;
  equipmentCode: string;
  mechanicName: string;
  /** `YYYY-MM-DD`. */
  date: string;
  declared: number;
  maintained: number;
  photos: number;
  /** 1 = primer envío; 2 o más = corregido tras un rechazo. */
  submission: number;
}

/**
 * Emitido al validar el supervisor un checklist diario (Módulo 3 · R25). Le
 * llega al mantenedor que lo hizo y al administrador: aceptado (el equipo
 * queda liberado) o rechazado con lo que hay que corregir.
 */
export interface ChecklistReviewedEvent {
  checklistId: string;
  equipmentId: string;
  equipmentCode: string;
  /** `YYYY-MM-DD`. */
  date: string;
  decision: 'ACCEPTED' | 'REJECTED';
  comment: string | null;
  reviewerName: string;
  mechanicId: string;
  mechanicName: string;
}

/**
 * Módulo 4 · R21: un documento del equipo entró en su plazo de aviso
 * (`POR_VENCER`) o venció (`VENCIDO`). Le llega al mantenedor y al
 * administrador una sola vez por documento, aviso y fecha.
 */
export interface DocumentExpiringEvent {
  documentId: string;
  equipmentId: string;
  equipmentCode: string;
  licensePlate: string | null;
  /** «Revisión técnica», «Seguro»… o el título del documento. */
  documentLabel: string;
  kind: 'POR_VENCER' | 'VENCIDO';
  /** `YYYY-MM-DD`. */
  expiryDate: string;
  /** Negativo si ya venció. */
  daysToExpiry: number;
}

/**
 * Módulo 4 · R21: a un vehículo liviano le falta poco para su mantención de
 * cada 10.000 km. Ya se creó la orden PREVENTIVA en el tablero del taller.
 */
export interface LightServiceDueEvent {
  equipmentId: string;
  equipmentCode: string;
  licensePlate: string | null;
  ordenId: string;
  /** El kilometraje en que toca (30.000). */
  nextKm: number;
  remainingKm: number;
}

/**
 * Un equipo con pauta entró al margen de aviso de su próxima mantención
 * (`MaintenancePlan.alertBefore`) y ya se creó la orden PREVENTIVA con las
 * operaciones del hito en el tablero del taller. Lo emite
 * `MaintenancePlansService.checkAlert` una sola vez por equipo, hito y vuelta
 * del ciclo — la misma condición con que crea la orden.
 */
export interface PreventiveServiceDueEvent {
  equipmentId: string;
  equipmentCode: string;
  ordenId: string;
  /** El hito que toca (250, 500…), en la unidad del equipo. */
  milestone: number;
  /** `h` o `km`, según cómo se mide el equipo. */
  unit: 'h' | 'km';
  /** Lo que le falta al contador para el hito; 0 si ya toca (o se pasó). */
  remaining: number;
}

/**
 * Se cargó combustible a una camioneta (equipo LIVIANO) desde Terreno. Le
 * llega al administrador (menos a quien la registró). Lo emite
 * `ShiftsService` DESPUÉS de confirmar la transacción, en exactamente tres
 * casos:
 * - `POST /shift-cards/:id/fuel-loads` (carga con la tarjeta abierta) →
 *   `origin: 'TARJETA_ABIERTA'`;
 * - `POST /shift-cards/:id/close` de un liviano con `fuelLiters > 0` →
 *   `origin: 'CIERRE'`;
 * - `POST /shift-cards/closed` (registro de un turno pasado) de un liviano
 *   con `fuelLiters > 0` → `origin: 'CIERRE'`.
 * Nunca en un reintento idempotente ni si la transacción falla; tampoco en
 * pesados, en el cierre de liviano solo con km, en el cierre del
 * administrador (`admin-close`, sin combustible) ni en el alta/corrección
 * manual del panel (`/combustible`).
 */
export interface FuelLoadedEvent {
  /** `RegistroCombustible.id` de la carga. */
  cargaId: string;
  /** La tarjeta de turno en que se registró. */
  cardId: string;
  equipmentId: string;
  equipmentCode: string;
  liters: number;
  /** Lectura del contador al cargar (km en un liviano). */
  reading: number;
  unit: 'h' | 'km';
  /** `TARJETA_ABIERTA`: carga sin cerrar la tarjeta; `CIERRE`: al cerrarla. */
  origin: 'TARJETA_ABIERTA' | 'CIERRE';
  /** Quién la registró (`user.id`): no se le avisa a sí mismo. */
  actorId: string;
  actorName: string;
  /** Rol de quien la registró (`ADMIN`, `SUPERVISOR`…). */
  actorRole: string | null;
}

/**
 * Terminó el turno de un supervisor y le quedaron pesados abiertos: el turno
 * siguiente no los ve para registrarlos. Lo emite `ShiftEndRemindersService`,
 * una sola vez por turno.
 */
export interface ShiftEndedWithOpenCardsEvent {
  supervisorId: string;
  shiftId: string;
  /** `YYYY-MM-DD` */
  shiftDate: string;
  shiftType: string;
  /** Códigos de los pesados que siguen abiertos (`CA-011`), ordenados. */
  equipmentCodes: string[];
}
