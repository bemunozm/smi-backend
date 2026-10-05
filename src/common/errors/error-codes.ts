/**
 * Clasificadores estables de error de negocio (`code` en el body de
 * `new XException({ message, code })`) — ver `HttpExceptionFilter`, que
 * pasa a la respuesta CUALQUIER `code` bien formado (UPPER_SNAKE) para que
 * el caller (ej. el outbox offline del front) distinga casos sin parsear
 * `message`. El filtro NO exige que el código esté en este inventario —
 * pero registra igual cada `code` nuevo aquí: un único inventario tipado
 * evita que el mismo caso se identifique con literales distintos en dos
 * throw sites y le da autocompletado/type-safety a quien lanza la
 * excepción.
 *
 * El valor de wire (el string) es el contrato con el frontend — no renombrar
 * una clave existente sin coordinar el cambio del lado del cliente.
 */
export const ERROR_CODES = {
  EQUIPMENT_BUSY: 'EQUIPMENT_BUSY',
  EQUIPMENT_NOT_OPERATIONAL: 'EQUIPMENT_NOT_OPERATIONAL',
  ID_CONFLICT: 'ID_CONFLICT',
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  ALREADY_CLOSED: 'ALREADY_CLOSED',
  NOT_OWNER: 'NOT_OWNER',
  HOURMETER_BELOW_INITIAL: 'HOURMETER_BELOW_INITIAL',
  INVALID_CAPTURE_TIME: 'INVALID_CAPTURE_TIME',
  INVALID_SHIFT_DATE: 'INVALID_SHIFT_DATE',
  TMP_KEY_EXPIRED: 'TMP_KEY_EXPIRED',
  SHIFT_CARD_CLOSE_ELSEWHERE: 'SHIFT_CARD_CLOSE_ELSEWHERE',
  SHIFT_NOT_FOUND: 'SHIFT_NOT_FOUND',
  NO_CARDS: 'NO_CARDS',
  REPORT_RATE_LIMITED: 'REPORT_RATE_LIMITED',
  OPERATOR_IN_USE: 'OPERATOR_IN_USE',
  OPERATOR_INACTIVE: 'OPERATOR_INACTIVE',
  STALE_UPDATE: 'STALE_UPDATE',
  CARD_NOT_CLOSED: 'CARD_NOT_CLOSED',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
