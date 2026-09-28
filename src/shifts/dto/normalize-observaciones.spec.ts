import { normalizeObservaciones } from './normalize-observaciones';

describe('normalizeObservaciones', () => {
  it('recorta espacios al inicio y al final', () => {
    expect(normalizeObservaciones('  hola  ')).toBe('hola');
  });

  it('convierte CRLF a LF', () => {
    expect(normalizeObservaciones('linea1\r\nlinea2')).toBe('linea1\nlinea2');
  });

  it('colapsa 3 o más saltos de línea seguidos a 2', () => {
    expect(normalizeObservaciones('a\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeObservaciones('a\n\n\nb')).toBe('a\n\nb');
  });

  it('no toca 2 saltos de línea seguidos (párrafo normal)', () => {
    expect(normalizeObservaciones('a\n\nb')).toBe('a\n\nb');
  });

  it('combina CRLF + colapso + trim en un solo pase', () => {
    expect(normalizeObservaciones('  a\r\n\r\n\r\nb  ')).toBe('a\n\nb');
  });

  it('deja pasar tal cual un valor que no es string, para que @IsString lo reporte', () => {
    expect(normalizeObservaciones(undefined)).toBeUndefined();
    expect(normalizeObservaciones(123)).toBe(123);
    expect(normalizeObservaciones(null)).toBeNull();
  });

  it('no lanza con un string vacío', () => {
    expect(normalizeObservaciones('')).toBe('');
  });
});
