import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  assertShiftDateWithinWindow,
  formatDateOnly,
  IsDateOnly,
  isValidDateOnly,
  liveCloseFuelDate,
  parseDateOnlyUtc,
  SHIFT_DATE_MAX_FUTURE_DAYS,
  SHIFT_DATE_MAX_PAST_DAYS,
} from './date-only';

const NOW = new Date('2026-09-28T12:00:00.000Z');

describe('isValidDateOnly', () => {
  it('acepta una fecha real', () => {
    expect(isValidDateOnly('2026-09-28')).toBe(true);
  });

  it('rechaza un mes fuera de rango (antes daba 500: Invalid Date -> RangeError al serializar)', () => {
    expect(isValidDateOnly('2026-13-45')).toBe(false);
  });

  it('rechaza un día que no existe en ese mes (antes pasaba silencioso: Date lo desborda a marzo)', () => {
    expect(isValidDateOnly('2026-02-31')).toBe(false);
    // Confirma el porqué: `new Date` NO da Invalid Date, rueda a marzo.
    expect(parseDateOnlyUtc('2026-02-31').getUTCMonth()).toBe(2); // marzo (0-indexed)
  });

  it('rechaza un shape inválido', () => {
    expect(isValidDateOnly('2026/09/28')).toBe(false);
    expect(isValidDateOnly('28-09-2026')).toBe(false);
    expect(isValidDateOnly('')).toBe(false);
  });

  it('el 29 de febrero de un año bisiesto sí es válido', () => {
    expect(isValidDateOnly('2028-02-29')).toBe(true);
  });

  it('el 29 de febrero de un año NO bisiesto no es válido', () => {
    expect(isValidDateOnly('2026-02-29')).toBe(false);
  });
});

class DateOnlyHolder {
  @IsDateOnly()
  date!: string;
}

class TypedHolder {
  @IsDateOnly()
  date!: unknown;
}

describe('@IsDateOnly()', () => {
  it('acepta una fecha real', async () => {
    const dto = plainToInstance(DateOnlyHolder, { date: '2026-09-28' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza 2026-13-45', async () => {
    const dto = plainToInstance(DateOnlyHolder, { date: '2026-13-45' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza 2026-02-31', async () => {
    const dto = plainToInstance(DateOnlyHolder, { date: '2026-02-31' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza un valor que no es string', async () => {
    const dto = plainToInstance(TypedHolder, { date: 20260928 });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});

describe('assertShiftDateWithinWindow', () => {
  it('acepta la fecha de hoy', () => {
    expect(() => assertShiftDateWithinWindow('2026-09-28', NOW)).not.toThrow();
  });

  it(`acepta hasta ${SHIFT_DATE_MAX_PAST_DAYS} días de antigüedad`, () => {
    expect(() => assertShiftDateWithinWindow('2026-08-29', NOW)).not.toThrow();
  });

  it(`rechaza más de ${SHIFT_DATE_MAX_PAST_DAYS} días de antigüedad`, () => {
    expect.assertions(2);
    try {
      assertShiftDateWithinWindow('2026-08-28', NOW);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'INVALID_SHIFT_DATE',
      });
    }
  });

  it(`acepta hasta ${SHIFT_DATE_MAX_FUTURE_DAYS} día a futuro`, () => {
    expect(() => assertShiftDateWithinWindow('2026-09-29', NOW)).not.toThrow();
  });

  it(`rechaza más de ${SHIFT_DATE_MAX_FUTURE_DAYS} día a futuro`, () => {
    expect(() => assertShiftDateWithinWindow('2026-09-30', NOW)).toThrow(
      BadRequestException,
    );
  });

  /** Regresión del bug de zona horaria: `now` cae entre la medianoche UTC y
   * la medianoche de Santiago (2:30 AM UTC del 29/09 sigue siendo 28/09 en
   * Chile) — con el cálculo viejo (calendario UTC), "hoy" habría sido
   * '2026-09-29' y '2026-09-30' habría quedado DENTRO de la ventana (+1 día)
   * en vez de fuera (+2 días reales desde el 28, el día real en Chile). */
  describe('cruzando la medianoche UTC (now entre 00:00Z y la medianoche de Santiago)', () => {
    const NOW_ACROSS_UTC_MIDNIGHT = new Date('2026-09-29T02:30:00.000Z');

    it('acepta el día de HOY en Santiago (28/09), no el día UTC del proceso (29/09)', () => {
      expect(() =>
        assertShiftDateWithinWindow('2026-09-28', NOW_ACROSS_UTC_MIDNIGHT),
      ).not.toThrow();
    });

    it(`acepta hasta ${SHIFT_DATE_MAX_FUTURE_DAYS} día a futuro DESDE el hoy de Santiago (29/09)`, () => {
      expect(() =>
        assertShiftDateWithinWindow('2026-09-29', NOW_ACROSS_UTC_MIDNIGHT),
      ).not.toThrow();
    });

    it('rechaza 2 días a futuro reales (30/09) — el bug viejo lo aceptaba por calcular "hoy" en UTC (29/09) en vez de Santiago (28/09)', () => {
      expect(() =>
        assertShiftDateWithinWindow('2026-09-30', NOW_ACROSS_UTC_MIDNIGHT),
      ).toThrow(BadRequestException);
    });

    it(`acepta hasta ${SHIFT_DATE_MAX_PAST_DAYS} días de antigüedad DESDE el hoy de Santiago (28/09)`, () => {
      expect(() =>
        assertShiftDateWithinWindow('2026-08-29', NOW_ACROSS_UTC_MIDNIGHT),
      ).not.toThrow();
    });

    it(`rechaza más de ${SHIFT_DATE_MAX_PAST_DAYS} días de antigüedad DESDE el hoy de Santiago (28/09)`, () => {
      expect(() =>
        assertShiftDateWithinWindow('2026-08-28', NOW_ACROSS_UTC_MIDNIGHT),
      ).toThrow(BadRequestException);
    });
  });
});

describe('liveCloseFuelDate', () => {
  it('un cierre de madrugada chilena (03:59, verano UTC-3) fecha la carga en el día ANTERIOR, 20:30 −03', () => {
    expect(
      liveCloseFuelDate(new Date('2026-11-13T06:59:00.000Z')).toISOString(),
    ).toBe('2026-11-12T23:30:00.000Z');
  });

  it('a las 08:00 chilenas exactas ya corre el turno diurno: el instante queda tal cual (misma referencia)', () => {
    const d = new Date('2026-11-13T11:00:00.000Z'); // 08:00 en Chile (UTC-3)
    expect(liveCloseFuelDate(d)).toBe(d);
  });

  it('un cierre de mediodía queda tal cual', () => {
    const d = new Date('2026-11-13T15:00:00.000Z'); // 12:00 en Chile
    expect(liveCloseFuelDate(d)).toBe(d);
  });

  it('en invierno chileno (UTC-4) la hora se evalúa en el reloj de Chile, no en UTC', () => {
    // 2026-06-15T10:00:00Z = 06:00 en Chile → nocturno que abrió el 14.
    expect(
      liveCloseFuelDate(new Date('2026-06-15T10:00:00.000Z')).toISOString(),
    ).toBe('2026-06-14T23:30:00.000Z');
  });

  it('cruza mes y año: la madrugada del 1 de enero pertenece al 31 de diciembre', () => {
    // 2026-01-01T05:00:00Z = 02:00 en Chile (verano, UTC-3).
    expect(
      liveCloseFuelDate(new Date('2026-01-01T05:00:00.000Z')).toISOString(),
    ).toBe('2025-12-31T23:30:00.000Z');
  });
});

describe('formatDateOnly / parseDateOnlyUtc (round-trip)', () => {
  it('formatDateOnly(parseDateOnlyUtc(x)) === x para una fecha válida', () => {
    expect(formatDateOnly(parseDateOnlyUtc('2026-01-05'))).toBe('2026-01-05');
  });
});
