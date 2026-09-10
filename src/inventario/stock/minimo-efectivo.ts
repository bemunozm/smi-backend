/** Resultado de evaluar el umbral de reposición de una bodega. */
export interface UmbralBodega {
  /** Umbral configurado para ESTA bodega. `0` = la bodega no fijó ninguno. */
  stockMinimo: number;
  bajoMinimo: boolean;
}

/**
 * Evalúa si el saldo de una bodega está bajo SU umbral de reposición (RFC-11).
 *
 * `Insumo.stockMinimo` y `StockSucursal.stockMinimo` **no son la misma
 * magnitud**: el primero es el umbral de la empresa (¿hay que comprar?) y el
 * segundo el de una bodega (¿hay que reponer acá?). Por eso el global NO se
 * hereda como umbral de bodega.
 *
 * La primera versión sí lo heredaba, con el argumento de que "el peor error es
 * no avisar". Al correrlo contra datos reales quedó claro que era al revés: los
 * mínimos globales están calibrados sobre el total de la empresa, así que
 * compararlos contra la porción de una bodega marcaba **los 10 de 10 ítems**
 * como bajo mínimo. Una alerta que se enciende siempre no es una alerta; enseña
 * a ignorar la pantalla, que es la peor falla posible para esta funcionalidad.
 *
 * Un umbral que nadie configuró no se puede cruzar: una bodega sin mínimo
 * propio no emite alerta de bodega. La alerta a nivel empresa sigue existiendo
 * aparte (`GET /api/inventario/insumos?bajoStock=true` y el evento
 * `INSUMO_LOW_STOCK`), y esa sí usa el umbral global.
 *
 * Vive en su propio archivo porque la usan dos dominios (`StockService` y la
 * consulta de repuestos compatibles de RFC-12). Duplicarla haría que la misma
 * fila apareciera "bajo mínimo" en una pantalla y "ok" en la otra.
 */
export function evaluarMinimoBodega(
  stock: number,
  minimoSucursal: number | undefined,
): UmbralBodega {
  const stockMinimo = minimoSucursal ?? 0;
  return { stockMinimo, bajoMinimo: stockMinimo > 0 && stock <= stockMinimo };
}
