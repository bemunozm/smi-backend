import { BadRequestException, ConflictException } from '@nestjs/common';

import {
  assertExpected,
  EXPECTED_HEADER_MAX_LENGTH,
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

  describe('forma estricta', () => {
    it('acepta valores primitivos, null y listas de primitivos', () => {
      const base = {
        texto: 'a',
        numero: 1.5,
        booleano: false,
        nulo: null,
        actividades: ['REGULACION_CARGA', 'OTRO'],
        vacia: [],
      };

      expect(
        parseExpectedHeader(encodeURIComponent(JSON.stringify(base))),
      ).toEqual(base);
    });

    it.each([
      ['un objeto', '{"campo":{"a":1}}'],
      ['una lista con objetos', '{"campo":[{"a":1}]}'],
      ['una lista anidada', '{"campo":[[1]]}'],
    ])('rechaza con 400 un valor que es %s', (_label, json) => {
      expect(() => parseExpectedHeader(encodeURIComponent(json))).toThrow(
        BadRequestException,
      );
    });

    it('un header de más del tope es 400 antes de parsear', () => {
      const raw = encodeURIComponent(
        JSON.stringify({ campo: 'a'.repeat(EXPECTED_HEADER_MAX_LENGTH) }),
      );

      expect(raw.length).toBeGreaterThan(EXPECTED_HEADER_MAX_LENGTH);
      expect(() => parseExpectedHeader(raw)).toThrow(BadRequestException);
    });

    it('un anidamiento profundo que cabe en el tope es 400, nunca un RangeError', () => {
      const profundo = '['.repeat(1300) + ']'.repeat(1300);
      const raw = encodeURIComponent(`{"campo":${profundo}}`);
      expect(raw.length).toBeLessThanOrEqual(EXPECTED_HEADER_MAX_LENGTH);

      expect(() => parseExpectedHeader(raw)).toThrow(BadRequestException);
    });

    it('__proto__ y constructor con valor primitivo se leen como claves comunes, sin tocar el prototipo', () => {
      const parsed = parseExpectedHeader(
        encodeURIComponent('{"__proto__":1,"constructor":"x"}'),
      );

      expect(parsed).toBeDefined();
      expect(Object.keys(parsed ?? {}).sort()).toEqual([
        '__proto__',
        'constructor',
      ]);
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>)['__proto__']).toBe(
        Object.prototype,
      );
    });

    it('__proto__ con un objeto es 400', () => {
      expect(() =>
        parseExpectedHeader(encodeURIComponent('{"__proto__":{"x":1}}')),
      ).toThrow(BadRequestException);
    });
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

  it('el mensaje nombra una sola vez una etiqueta compartida por dos campos', () => {
    let error: unknown;
    try {
      assertExpected(
        { operatorId: 'op_2', operador: 'Pedro' },
        { operatorId: 'op_1', operador: 'Juan' },
        { operatorId: 'op_3', operador: 'Ana' },
        { operatorId: 'Operador', operador: 'Operador', faena: 'Faena' },
      );
    } catch (e) {
      error = e;
    }

    const { message } = (error as ConflictException).getResponse() as {
      message: string;
    };
    expect(message).toContain('(Operador)');
    expect(message).not.toContain('Operador, Operador');
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

  it('un campo heredado del prototipo no es un campo de la fila', () => {
    // Con `in`, `constructor` y `toString` existen en cualquier objeto y
    // darían un conflicto falso contra el valor «esperado».
    expect(() =>
      assertExpected(
        current,
        { constructor: 'x', toString: 'y', hasOwnProperty: 'z' },
        {},
      ),
    ).not.toThrow();
  });

  it('un `desired` heredado tampoco cuenta como campo tocado', () => {
    expect(() =>
      assertExpected(
        { a: 1 },
        { a: 1 },
        Object.create({ a: 99 }) as Record<string, unknown>,
      ),
    ).not.toThrow();
  });
});
