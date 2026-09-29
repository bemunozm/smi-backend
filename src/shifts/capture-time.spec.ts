import { BadRequestException } from '@nestjs/common';

import {
  assertReasonableCapturedAt,
  computeClientClockSkewMs,
  MAX_FUTURE_CAPTURE_SKEW_MS,
  MAX_PAST_CAPTURE_SKEW_MS,
  resolveCapturedAtWithFallback,
} from './capture-time';

const NOW = new Date('2026-09-28T12:00:00.000Z');

describe('assertReasonableCapturedAt', () => {
  it('acepta la hora actual', () => {
    expect(() => assertReasonableCapturedAt(NOW, NOW)).not.toThrow();
  });

  it('acepta hasta 24h en el futuro', () => {
    const capturedAt = new Date(NOW.getTime() + MAX_FUTURE_CAPTURE_SKEW_MS);
    expect(() => assertReasonableCapturedAt(capturedAt, NOW)).not.toThrow();
  });

  it('rechaza más de 24h en el futuro', () => {
    const capturedAt = new Date(NOW.getTime() + MAX_FUTURE_CAPTURE_SKEW_MS + 1);
    expect(() => assertReasonableCapturedAt(capturedAt, NOW)).toThrow(
      BadRequestException,
    );
  });

  it('acepta hasta 7 días de antigüedad', () => {
    const capturedAt = new Date(NOW.getTime() - MAX_PAST_CAPTURE_SKEW_MS);
    expect(() => assertReasonableCapturedAt(capturedAt, NOW)).not.toThrow();
  });

  it('rechaza más de 7 días de antigüedad', () => {
    const capturedAt = new Date(NOW.getTime() - MAX_PAST_CAPTURE_SKEW_MS - 1);
    expect(() => assertReasonableCapturedAt(capturedAt, NOW)).toThrow(
      BadRequestException,
    );
  });

  it('rechaza una fecha no parseable (NaN) con INVALID_CAPTURE_TIME', () => {
    expect.assertions(2);
    try {
      assertReasonableCapturedAt(new Date('2026-W01'), NOW);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'INVALID_CAPTURE_TIME',
      });
    }
  });
});

describe('computeClientClockSkewMs', () => {
  it('sin header, undefined (no se audita, no se rechaza)', () => {
    expect(computeClientClockSkewMs(undefined, NOW)).toBeUndefined();
  });

  it('header no parseable, undefined', () => {
    expect(computeClientClockSkewMs('no-es-una-fecha', NOW)).toBeUndefined();
  });

  it('calcula serverNow - clientNow para un desfase normal', () => {
    const clientTime = new Date(NOW.getTime() - 5000).toISOString();
    expect(computeClientClockSkewMs(clientTime, NOW)).toBe(5000);
  });

  it('el epoch (1970-01-01T00:00:00Z) desborda INTEGER de Postgres -> undefined, NO lanza', () => {
    expect(() =>
      computeClientClockSkewMs('1970-01-01T00:00:00Z', NOW),
    ).not.toThrow();
    expect(
      computeClientClockSkewMs('1970-01-01T00:00:00Z', NOW),
    ).toBeUndefined();
  });

  it('un desfase futuro absurdo (año 2200) también desborda INTEGER -> undefined', () => {
    expect(
      computeClientClockSkewMs('2200-01-01T00:00:00Z', NOW),
    ).toBeUndefined();
  });

  it('un desfase grande pero dentro de INT4 se audita normalmente', () => {
    // ~24 días, bastante menos que el límite INT4 (~24.8 días en ms).
    const clientTime = new Date(
      NOW.getTime() - 24 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(computeClientClockSkewMs(clientTime, NOW)).toBe(
      24 * 24 * 60 * 60 * 1000,
    );
  });
});

describe('resolveCapturedAtWithFallback', () => {
  const fallback = NOW;

  it('sin value, usa el fallback', () => {
    expect(resolveCapturedAtWithFallback(undefined, fallback, NOW)).toBe(
      fallback,
    );
  });

  it('value no parseable (ej. "2026-W01"), usa el fallback sin lanzar', () => {
    expect(() =>
      resolveCapturedAtWithFallback('2026-W01', fallback, NOW),
    ).not.toThrow();
    expect(resolveCapturedAtWithFallback('2026-W01', fallback, NOW)).toBe(
      fallback,
    );
  });

  it('value válido y dentro de la ventana razonable, se usa tal cual', () => {
    const value = new Date(NOW.getTime() - 60_000).toISOString();
    const result = resolveCapturedAtWithFallback(value, fallback, NOW);
    expect(result.toISOString()).toBe(value);
  });

  it('value válido pero fuera de la ventana (EXIF con reloj mal configurado), usa el fallback', () => {
    const value = new Date(
      NOW.getTime() - MAX_PAST_CAPTURE_SKEW_MS - 1,
    ).toISOString();
    expect(resolveCapturedAtWithFallback(value, fallback, NOW)).toBe(fallback);
  });

  it('nunca lanza, ni con un valor absurdo', () => {
    expect(() =>
      resolveCapturedAtWithFallback('no-es-una-fecha', fallback, NOW),
    ).not.toThrow();
  });
});
