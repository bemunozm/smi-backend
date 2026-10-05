import { BadRequestException } from '@nestjs/common';

import {
  computeClientClockSkewMs,
  MAX_FUTURE_CAPTURE_SKEW_MS,
  MAX_PAST_CAPTURE_SKEW_MS,
  resolveCapturedAt,
  resolveCapturedAtWithFallback,
} from './capture-time';

const NOW = new Date('2026-09-28T12:00:00.000Z');

describe('resolveCapturedAt', () => {
  it('sin valor usa la hora del servidor, sin desfase', () => {
    expect(resolveCapturedAt(undefined, NOW)).toEqual({
      at: NOW,
      discardedSkewMs: undefined,
    });
    expect(resolveCapturedAt('', NOW).at).toBe(NOW);
  });

  it('usa la hora del dispositivo si está dentro de la ventana', () => {
    const value = new Date(NOW.getTime() - 60_000).toISOString();
    const result = resolveCapturedAt(value, NOW);
    expect(result.at.toISOString()).toBe(value);
    expect(result.discardedSkewMs).toBeUndefined();
  });

  it('acepta justo 24 h en el futuro y justo 7 días atrás', () => {
    const future = new Date(NOW.getTime() + MAX_FUTURE_CAPTURE_SKEW_MS);
    const past = new Date(NOW.getTime() - MAX_PAST_CAPTURE_SKEW_MS);
    expect(resolveCapturedAt(future.toISOString(), NOW).at).toEqual(future);
    expect(resolveCapturedAt(past.toISOString(), NOW).at).toEqual(past);
  });

  it('más de 24 h en el futuro: no rechaza, usa la hora del servidor y deja el desfase', () => {
    const device = new Date(NOW.getTime() + MAX_FUTURE_CAPTURE_SKEW_MS + 1);
    const result = resolveCapturedAt(device.toISOString(), NOW);
    expect(result.at).toBe(NOW);
    expect(result.discardedSkewMs).toBe(-(MAX_FUTURE_CAPTURE_SKEW_MS + 1));
  });

  it('más de 7 días atrás: no rechaza, usa la hora del servidor y deja el desfase', () => {
    const device = new Date(NOW.getTime() - MAX_PAST_CAPTURE_SKEW_MS - 1);
    const result = resolveCapturedAt(device.toISOString(), NOW);
    expect(result.at).toBe(NOW);
    expect(result.discardedSkewMs).toBe(MAX_PAST_CAPTURE_SKEW_MS + 1);
  });

  it('un desfase que desborda INTEGER se descarta, sin lanzar', () => {
    const result = resolveCapturedAt('1970-01-01T00:00:00Z', NOW);
    expect(result.at).toBe(NOW);
    expect(result.discardedSkewMs).toBeUndefined();
  });

  it('un formato que no es fecha sigue siendo 400 INVALID_CAPTURE_TIME', () => {
    expect.assertions(2);
    try {
      resolveCapturedAt('2026-W01', NOW);
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
