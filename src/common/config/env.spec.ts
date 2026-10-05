import {
  MAX_STORAGE_SIGNED_URL_TTL_SECONDS,
  MIN_STORAGE_SIGNED_URL_TTL_SECONDS,
  parseAuthRateLimitEnabled,
  parseStorageSignedUrlTtlSeconds,
} from './env';

/**
 * Cubre el máximo de `STORAGE_SIGNED_URL_TTL_SECONDS` (403200):
 * `StorageService.sign` firma con `expiresIn = TTL + floor(TTL/2)` (ventana
 * estable, ver `storage.service.ts`), así que un TTL de 604800 daría
 * expiresIn=907200, por encima del límite real de SigV4 (604800), y
 * `getSignedUrl` lo rechaza.
 */
describe('parseStorageSignedUrlTtlSeconds', () => {
  it('sin valor, cae al default (3600)', () => {
    expect(parseStorageSignedUrlTtlSeconds(undefined)).toBe(3600);
  });

  it('acepta el máximo (403200) — MAX + floor(MAX/2) da EXACTO el límite real de SigV4 (604800)', () => {
    const ttl = parseStorageSignedUrlTtlSeconds(
      String(MAX_STORAGE_SIGNED_URL_TTL_SECONDS),
    );
    expect(ttl).toBe(403200);

    const windowSeconds = Math.floor(ttl / 2);
    expect(ttl + windowSeconds).toBe(604800);
  });

  it('rechaza un valor por encima del máximo', () => {
    expect(() =>
      parseStorageSignedUrlTtlSeconds(
        String(MAX_STORAGE_SIGNED_URL_TTL_SECONDS + 1),
      ),
    ).toThrow(/STORAGE_SIGNED_URL_TTL_SECONDS/);
  });

  it('604800 no es válido (excede el máximo)', () => {
    expect(() => parseStorageSignedUrlTtlSeconds('604800')).toThrow();
  });

  it('acepta el mínimo (60)', () => {
    expect(
      parseStorageSignedUrlTtlSeconds(
        String(MIN_STORAGE_SIGNED_URL_TTL_SECONDS),
      ),
    ).toBe(60);
  });

  it('rechaza un valor por debajo del mínimo', () => {
    expect(() => parseStorageSignedUrlTtlSeconds('59')).toThrow();
  });

  it('rechaza un valor no entero', () => {
    expect(() => parseStorageSignedUrlTtlSeconds('3600.5')).toThrow();
  });
});

/**
 * `AUTH_RATE_LIMIT_ENABLED` gobierna el `rateLimit.enabled` de Better Auth
 * (`auth.ts`) — sin valor
 * explícito, cae al default de si el proceso corre en producción o no (para
 * no romper el e2e suite, que hace login muchas veces seguidas).
 */
describe('parseAuthRateLimitEnabled', () => {
  it('sin valor, usa el default de producción (true) cuando NODE_ENV=production', () => {
    expect(parseAuthRateLimitEnabled(undefined, true)).toBe(true);
  });

  it('sin valor, usa el default (false) fuera de producción', () => {
    expect(parseAuthRateLimitEnabled(undefined, false)).toBe(false);
  });

  it('un valor explícito "true" gana aunque el default sea false (fuera de producción)', () => {
    expect(parseAuthRateLimitEnabled('true', false)).toBe(true);
  });

  it('un valor explícito "false" gana aunque el default sea true (producción)', () => {
    expect(parseAuthRateLimitEnabled('false', true)).toBe(false);
  });

  it('string vacío se trata como "sin valor" (usa el default)', () => {
    expect(parseAuthRateLimitEnabled('  ', true)).toBe(true);
  });
});
