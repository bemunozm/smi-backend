/**
 * Solo las partes PURAS de `set-password.ts` (parseo de argumentos y
 * validación del largo mínimo) — `main()` toca Prisma real y no se testea
 * acá; la verificación en vivo (login vía curl, revertir al password seed)
 * se hizo aparte contra la DB de dev, ver SECURITY-NOTES.md.
 */
import {
  assertValidNewPassword,
  MIN_PASSWORD_LENGTH,
  parseArgs,
  SetPasswordUsageError,
} from './set-password';

describe('parseArgs', () => {
  it('acepta --email <email>', () => {
    expect(parseArgs(['--email', 'admin@smi.local'])).toEqual({
      email: 'admin@smi.local',
    });
  });

  it('ignora otros flags que vengan antes o después', () => {
    expect(
      parseArgs(['--dry-run', '--email', 'admin@smi.local', '--verbose']),
    ).toEqual({ email: 'admin@smi.local' });
  });

  it('rechaza si falta --email', () => {
    expect(() => parseArgs([])).toThrow(SetPasswordUsageError);
  });

  it('rechaza si --email no trae valor (es el último argumento)', () => {
    expect(() => parseArgs(['--email'])).toThrow(SetPasswordUsageError);
  });

  it('rechaza si el valor de --email en realidad es otro flag (--email --verbose)', () => {
    expect(() => parseArgs(['--email', '--verbose'])).toThrow(
      SetPasswordUsageError,
    );
  });
});

describe('assertValidNewPassword', () => {
  it('acepta una contraseña que cumple el mínimo', () => {
    expect(assertValidNewPassword('Smi123456!')).toBe('Smi123456!');
  });

  it('acepta exactamente el mínimo', () => {
    const exact = 'a'.repeat(MIN_PASSWORD_LENGTH);
    expect(assertValidNewPassword(exact)).toBe(exact);
  });

  it('rechaza undefined (NEW_PASSWORD no seteada)', () => {
    expect(() => assertValidNewPassword(undefined)).toThrow(
      SetPasswordUsageError,
    );
  });

  it('rechaza el string vacío', () => {
    expect(() => assertValidNewPassword('')).toThrow(SetPasswordUsageError);
  });

  it('rechaza por debajo del mínimo', () => {
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
    expect(() => assertValidNewPassword(short)).toThrow(SetPasswordUsageError);
  });

  it('respeta un minLength custom (parámetro, no hardcodeado)', () => {
    expect(() => assertValidNewPassword('1234567890', 12)).toThrow(
      SetPasswordUsageError,
    );
    expect(assertValidNewPassword('123456789012', 12)).toBe('123456789012');
  });
});
