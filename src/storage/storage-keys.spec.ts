import { BadRequestException } from '@nestjs/common';

import {
  assertOwnedTmpKey,
  buildFinalKey,
  buildTmpKey,
  FILE_KINDS,
  TMP_KEY_REGEX,
} from './storage-keys';

const USER_ID = 'uOWvhyBv6Ir39b949hWib447vHqAjXqG'; // 32 chars, como los ids reales de Better Auth

describe('storage-keys', () => {
  describe('buildTmpKey', () => {
    it('genera una key tmp/<userId>/<uuid>.<ext> que matchea TMP_KEY_REGEX', () => {
      const key = buildTmpKey(USER_ID, 'jpg');
      expect(key).toMatch(TMP_KEY_REGEX);
      expect(key.startsWith(`tmp/${USER_ID}/`)).toBe(true);
      expect(key.endsWith('.jpg')).toBe(true);
    });

    it('cada llamada genera un uuid distinto', () => {
      const first = buildTmpKey(USER_ID, 'png');
      const second = buildTmpKey(USER_ID, 'png');
      expect(first).not.toBe(second);
    });
  });

  describe('buildFinalKey', () => {
    it('usa el prefijo del kind y una extensión nueva', () => {
      const key = buildFinalKey('equipment-photo', 'webp');
      expect(key.startsWith(FILE_KINDS['equipment-photo'].prefix)).toBe(true);
      expect(key.endsWith('.webp')).toBe(true);
    });

    it('difiere entre kinds distintos', () => {
      const photoKey = buildFinalKey('equipment-photo', 'jpg');
      const docKey = buildFinalKey('equipment-document', 'jpg');
      expect(photoKey.startsWith('equipment-photos/')).toBe(true);
      expect(docKey.startsWith('equipment-documents/')).toBe(true);
    });
  });

  describe('TMP_KEY_REGEX', () => {
    it.each([
      `tmp/${USER_ID}/550e8400-e29b-41d4-a716-446655440000.jpg`,
      `tmp/${USER_ID}/550e8400-e29b-41d4-a716-446655440000.png`,
      `tmp/${USER_ID}/550e8400-e29b-41d4-a716-446655440000.webp`,
      `tmp/${USER_ID}/550e8400-e29b-41d4-a716-446655440000.pdf`,
    ])('matchea una key tmp válida: %s', (key) => {
      expect(TMP_KEY_REGEX.test(key)).toBe(true);
    });

    it.each([
      [
        'traversal en el userId',
        `tmp/../etc/passwd/550e8400-e29b-41d4-a716-446655440000.jpg`,
      ],
      ['sin extensión', `tmp/${USER_ID}/550e8400-e29b-41d4-a716-446655440000`],
      [
        'extensión no soportada',
        `tmp/${USER_ID}/550e8400-e29b-41d4-a716-446655440000.exe`,
      ],
      [
        'segmento extra',
        `tmp/${USER_ID}/sub/550e8400-e29b-41d4-a716-446655440000.jpg`,
      ],
      ['userId vacío', `tmp//550e8400-e29b-41d4-a716-446655440000.jpg`],
      [
        'userId con símbolos',
        `tmp/${USER_ID}!/550e8400-e29b-41d4-a716-446655440000.jpg`,
      ],
      ['uuid inválido', `tmp/${USER_ID}/no-es-un-uuid.jpg`],
      [
        'key final, no tmp',
        `equipment-photos/550e8400-e29b-41d4-a716-446655440000.jpg`,
      ],
      [
        'con query string colado',
        `tmp/${USER_ID}/550e8400-e29b-41d4-a716-446655440000.jpg?x=1`,
      ],
    ])('rechaza: %s', (_label, key) => {
      expect(TMP_KEY_REGEX.test(key)).toBe(false);
    });
  });

  describe('assertOwnedTmpKey', () => {
    it('devuelve la extensión cuando la key es del dueño y del kind correcto', () => {
      const key = buildTmpKey(USER_ID, 'jpg');
      const result = assertOwnedTmpKey(key, USER_ID, 'equipment-photo');
      expect(result.ext).toBe('jpg');
    });

    it('rechaza una key que no tiene shape tmp/', () => {
      expect(() =>
        assertOwnedTmpKey('equipment-photos/x.jpg', USER_ID, 'equipment-photo'),
      ).toThrow(BadRequestException);
    });

    it('rechaza una key tmp/ de otro usuario', () => {
      const key = buildTmpKey('rr0e95bkEtZxJdfgyKanpiWC37gPY439', 'jpg');
      expect(() => assertOwnedTmpKey(key, USER_ID, 'equipment-photo')).toThrow(
        BadRequestException,
      );
    });

    it('rechaza una extensión no permitida para el kind (pdf en equipment-photo)', () => {
      const key = buildTmpKey(USER_ID, 'pdf');
      expect(() => assertOwnedTmpKey(key, USER_ID, 'equipment-photo')).toThrow(
        BadRequestException,
      );
    });

    it('acepta pdf para equipment-document', () => {
      const key = buildTmpKey(USER_ID, 'pdf');
      const result = assertOwnedTmpKey(key, USER_ID, 'equipment-document');
      expect(result.ext).toBe('pdf');
    });

    it('rechaza pdf para fuel-photo', () => {
      const key = buildTmpKey(USER_ID, 'pdf');
      expect(() => assertOwnedTmpKey(key, USER_ID, 'fuel-photo')).toThrow(
        BadRequestException,
      );
    });
  });
});
