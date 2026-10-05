const MAX_FRACTION_DIGITS = 2;

const formatter = new Intl.NumberFormat('es-CL', {
  maximumFractionDigits: MAX_FRACTION_DIGITS,
  // `es` no agrupa los números de 4 cifras por defecto; los textos que lee una
  // persona usan el mismo «2.126,5» que muestra la pantalla.
  useGrouping: 'always',
});

/**
 * Número para un texto que lee una persona (avisos, historial de cambios,
 * mensajes de error): formato es-CL, coma decimal, punto de miles y hasta 2
 * decimales. Nunca para datos que el frontend parsea: esos viajan como número.
 */
export function formatNumber(value: number): string {
  return Number.isFinite(value) ? formatter.format(value) : String(value);
}
