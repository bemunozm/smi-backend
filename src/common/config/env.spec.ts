import {
  MAX_STORAGE_SIGNED_URL_TTL_SECONDS,
  MIN_STORAGE_SIGNED_URL_TTL_SECONDS,
  parseStorageSignedUrlTtlSeconds,
} from './env';

/**
 * Cubre el fix del punto 0 del plan de Fase 2 (RFC R2-storage): el máximo
 * de `STORAGE_SIGNED_URL_TTL_SECONDS` bajó de 604800 a 403200 porque
 * `StorageService.sign` firma con `expiresIn = TTL + floor(TTL/2)` (ventana
 * estable, ver `storage.service.ts`) — con el máximo viejo (604800) eso daba
 * expiresIn=907200, por encima del límite real de SigV4 (604800), y
 * `getSignedUrl` lo rechaza.
 */
describe('parseStorageSignedUrlTtlSeconds', () => {
  it('sin valor, cae al default (3600)', () => {
    expect(parseStorageSignedUrlTtlSeconds(undefined)).toBe(3600);
  });

  it('acepta el nuevo máximo (403200) — MAX + floor(MAX/2) da EXACTO el límite real de SigV4 (604800)', () => {
    const ttl = parseStorageSignedUrlTtlSeconds(
      String(MAX_STORAGE_SIGNED_URL_TTL_SECONDS),
    );
    expect(ttl).toBe(403200);

    const windowSeconds = Math.floor(ttl / 2);
    expect(ttl + windowSeconds).toBe(604800);
  });

  it('rechaza un valor por encima del nuevo máximo', () => {
    expect(() =>
      parseStorageSignedUrlTtlSeconds(
        String(MAX_STORAGE_SIGNED_URL_TTL_SECONDS + 1),
      ),
    ).toThrow(/STORAGE_SIGNED_URL_TTL_SECONDS/);
  });

  it('el viejo máximo (604800) ya NO es válido', () => {
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
