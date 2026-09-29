import { isValidRut, normalizeRut } from './rut';

describe('isValidRut', () => {
  it('acepta un RUT con dígito verificador correcto', () => {
    expect(isValidRut('12345678-5')).toBe(true);
    expect(isValidRut('11111111-1')).toBe(true);
  });

  it('acepta un dígito verificador K (mayúscula o minúscula)', () => {
    expect(isValidRut('40000000-K')).toBe(true);
    expect(isValidRut('40000000-k')).toBe(true);
  });

  it('tolera puntos y espacios', () => {
    expect(isValidRut('12.345.678-5')).toBe(true);
    expect(isValidRut('12345678 5')).toBe(true);
    expect(isValidRut(' 12345678-5 ')).toBe(true);
  });

  it('rechaza un dígito verificador incorrecto', () => {
    expect(isValidRut('12345678-9')).toBe(false);
    expect(isValidRut('12345678-K')).toBe(false);
  });

  it('rechaza un cuerpo no numérico', () => {
    expect(isValidRut('ABCDEFGH-5')).toBe(false);
  });

  it('rechaza un cuerpo fuera de 7-8 dígitos', () => {
    expect(isValidRut('123456-4')).toBe(false); // 6 dígitos
    expect(isValidRut('123456789-6')).toBe(false); // 9 dígitos
  });

  it('rechaza un string vacío', () => {
    expect(isValidRut('')).toBe(false);
  });
});

describe('normalizeRut', () => {
  it('normaliza al formato canónico "12345678-K"', () => {
    expect(normalizeRut('12.345.678-5')).toBe('12345678-5');
    expect(normalizeRut('40000000-k')).toBe('40000000-K');
    expect(normalizeRut('11111111-1')).toBe('11111111-1');
  });

  it('lanza si el RUT no es válido', () => {
    expect(() => normalizeRut('12345678-9')).toThrow('RUT inválido');
  });

  // Un cero a la izquierda en el cuerpo no cambia el dígito verificador
  // (multiplica por 0 en el algoritmo módulo
  // 11 — mismo caso real que "01234567-4" vs "1234567-4"), así que es el
  // MISMO RUT y debe normalizar al mismo canónico para chocar con el
  // `@unique` de `Operator.rut`.
  it('colapsa un cero a la izquierda al mismo canónico que sin el cero', () => {
    expect(normalizeRut('01234567-4')).toBe(normalizeRut('1234567-4'));
    expect(normalizeRut('01234567-4')).toBe('1234567-4');
  });

  it('un cero a la izquierda con puntos también colapsa', () => {
    expect(normalizeRut('01.234.567-4')).toBe('1234567-4');
  });
});
