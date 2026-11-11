import { formatNumber } from '../common/format/number';

/** Tope de litros de combustible por carga: cubre cargas de flota/estanque grandes y atrapa un kilometraje u horómetro tipeado en el campo de litros. */
export const FUEL_LITERS_MAX = 100_000;

/** Mensaje de validación compartido por cierre y edición de la tarjeta de turno. */
export const FUEL_LITERS_MAX_MESSAGE = `Los litros no pueden superar ${formatNumber(FUEL_LITERS_MAX)} L: revisa que no sea el kilometraje u horómetro.`;
