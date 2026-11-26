import { BadRequestException } from '@nestjs/common';

/** Solo dígitos, con espacios alrededor tolerados (se recortan). */
export const FOLIO_REGEX = /^\s*\d+\s*$/;

export const FOLIO_SOLO_NUMEROS = 'El N° de report lleva solo números.';

/**
 * El N° de report (folio del papel) en su forma canónica: dígitos sin ceros a
 * la izquierda («04615» → «4615»). Es THE número del Report (decisión del
 * cliente, 26-11) y es único: se guarda normalizado para que «04615» y «4615»
 * no puedan convivir como dos reports distintos. 400 si no es un entero
 * positivo.
 */
export function normalizarFolio(texto: string): string {
  if (!FOLIO_REGEX.test(texto)) {
    throw new BadRequestException(FOLIO_SOLO_NUMEROS);
  }
  const folio = texto.trim().replace(/^0+/, '');
  if (folio === '') {
    throw new BadRequestException('El N° de report tiene que ser mayor que 0.');
  }
  return folio;
}
