import { BadRequestException, ConflictException } from '@nestjs/common';

import {
  assertExpected,
  normalizeComparable,
  parseExpectedHeader,
} from './expected-fields';

describe('parseExpectedHeader', () => {
  it('sin header o vacío no hay precondición', () => {
    expect(parseExpectedHeader(undefined)).toBeUndefined();
    expect(parseExpectedHeader('')).toBeUndefined();
    expect(parseExpectedHeader('   ')).toBeUndefined();
  });

  it('lee un objeto JSON', () => {
    expect(
      parseExpectedHeader(
        encodeURIComponent('{"valorFinal":130,"observaciones":null}'),
      ),
    ).toEqual({ valorFinal: 130, observaciones: null });
  });

  it('decodifica texto no ASCII (tipográficas, guion largo, ñ, emoji)', () => {
    const base = { observaciones: 'Revisión — “ok” ñ 🚜' };
    expect(
      parseExpectedHeader(encodeURIComponent(JSON.stringify(base))),
    ).toEqual(base);
  });

  it('un valor con % o URI mal formada es 400, no 500', () => {
    expect(() => parseExpectedHeader('%E0%A4%A')).toThrow(BadRequestException);
    expect(() => parseExpectedHeader('%')).toThrow(BadRequestException);
  });

  it.each(
    ['{no-json', 'null', '[1,2]', '"texto"', '5'].map(encodeURIComponent),
  )('rechaza con 400 lo que no es un objeto JSON (%s)', (raw) => {
    expect(() => parseExpectedHeader(raw)).toThrow(BadRequestException);
  });
});

describe('normalizeComparable', () => {
  it('null, undefined y texto vacío son lo mismo', () => {
    expect(normalizeComparable(undefined)).toBeNull();
    expect(normalizeComparable(null)).toBeNull();
    expect(normalizeComparable('  ')).toBeNull();
  });

  it('recorta el texto y deja los números y booleanos tal cual', () => {
    expect(normalizeComparable('  hola ')).toBe('hola');
    expect(normalizeComparable(0)).toBe(0);
    expect(normalizeComparable(false)).toBe(false);
  });

  it('los arreglos se comparan por contenido', () => {
    expect(normalizeComparable(['A', 'B'])).toBe(
      normalizeComparable(['A', 'B']),
    );
  });
});

describe('assertExpected', () => {
  const current = { valorFinal: 130, observaciones: null, adBlue: false };

  it('sin expected no valida nada', () => {
    expect(() =>
      assertExpected(current, undefined, { valorFinal: 1 }),
    ).not.toThrow();
  });

  it('pasa si el valor vigente es el esperado', () => {
    expect(() =>
      assertExpected(current, { valorFinal: 130 }, { valorFinal: 140 }),
    ).not.toThrow();
  });

  it('pasa (reintento idempotente) si el valor vigente ya es el deseado', () => {
    expect(() =>
      assertExpected(
        { valorFinal: 140 },
        { valorFinal: 130 },
        { valorFinal: 140 },
      ),
    ).not.toThrow();
  });

  it('409 STALE_UPDATE si no es ni el esperado ni el deseado, nombrando los campos', () => {
    let error: unknown;
    try {
      assertExpected(
        { valorFinal: 150, observaciones: 'otra' },
        { valorFinal: 130, observaciones: null },
        { valorFinal: 140, observaciones: 'mia' },
        { valorFinal: 'Lectura final', observaciones: 'Observaciones' },
      );
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('STALE_UPDATE');
    expect(body.message).toContain('Lectura final');
    expect(body.message).toContain('Observaciones');
  });

  it('null y undefined son equivalentes, y el texto se compara recortado', () => {
    expect(() =>
      assertExpected(
        { observaciones: ' hola ', otro: undefined },
        { observaciones: 'hola', otro: null },
        {},
      ),
    ).not.toThrow();
  });

  it('el 0 no es lo mismo que sin valor', () => {
    expect(() =>
      assertExpected(
        { fuelLiters: null },
        { fuelLiters: 0 },
        { fuelLiters: 5 },
      ),
    ).toThrow(ConflictException);
  });

  it('un campo que el body no toca se compara contra lo vigente: ni falso pase ni falso conflicto', () => {
    // No está en `desired`: aunque `expected` difiera de lo vigente no se pisa nada.
    expect(() =>
      assertExpected({ a: 1, b: 2 }, { a: 1, b: 99 }, { a: 5 }),
    ).not.toThrow();
    // Sí está en `desired` y es ajeno: conflicto.
    expect(() => assertExpected({ a: 3 }, { a: 1 }, { a: 5 })).toThrow(
      ConflictException,
    );
  });

  it('ignora los campos que el servidor no conoce', () => {
    expect(() =>
      assertExpected(current, { campoNuevo: 'x' }, {}),
    ).not.toThrow();
  });
});
