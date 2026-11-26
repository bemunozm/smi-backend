import { BadRequestException } from '@nestjs/common';

import { normalizarFolio } from './folio';

describe('normalizarFolio', () => {
  it('recorta espacios y quita los ceros a la izquierda', () => {
    expect(normalizarFolio(' 04615 ')).toBe('4615');
    expect(normalizarFolio('4615')).toBe('4615');
  });

  it('rechaza letras, signos y vacíos', () => {
    for (const malo of ['46A', '4-615', '', '  ', '4615.0', '-1']) {
      expect(() => normalizarFolio(malo)).toThrow(BadRequestException);
    }
  });

  it('rechaza el cero', () => {
    expect(() => normalizarFolio('000')).toThrow(BadRequestException);
  });
});
