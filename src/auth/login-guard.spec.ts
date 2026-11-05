import {
  BLOQUEO_MS,
  LoginGuard,
  MAX_FALLOS,
  mensajeBloqueo,
} from './login-guard';

describe('LoginGuard — bloqueo por cuenta', () => {
  let t: number;
  let guard: LoginGuard;

  beforeEach(() => {
    t = 1_000_000;
    guard = new LoginGuard(() => t);
  });

  const fallar = (email: string, veces: number) => {
    for (let i = 0; i < veces; i++) guard.registrarFallo(email);
  };

  it(`bloquea la cuenta al ${MAX_FALLOS}.º fallo seguido, no antes`, () => {
    fallar('ana@smi.local', MAX_FALLOS - 1);
    expect(guard.restante('ana@smi.local')).toBe(0);
    guard.registrarFallo('ana@smi.local');
    expect(guard.restante('ana@smi.local')).toBe(BLOQUEO_MS);
  });

  it('solo bloquea esa cuenta: otra desde la misma red sigue entrando', () => {
    fallar('ana@smi.local', MAX_FALLOS);
    expect(guard.restante('jorge@smi.local')).toBe(0);
  });

  it('el correo no distingue mayúsculas ni espacios', () => {
    fallar(' Ana@SMI.local ', MAX_FALLOS);
    expect(guard.restante('ana@smi.local')).toBeGreaterThan(0);
  });

  it('un login correcto antes del tope reinicia la cuenta', () => {
    fallar('ana@smi.local', MAX_FALLOS - 1);
    guard.registrarExito('ana@smi.local');
    guard.registrarFallo('ana@smi.local');
    expect(guard.restante('ana@smi.local')).toBe(0);
  });

  it('cumplido el bloqueo, vuelve a tener todos sus intentos', () => {
    fallar('ana@smi.local', MAX_FALLOS);
    t += BLOQUEO_MS + 1;
    expect(guard.restante('ana@smi.local')).toBe(0);
    guard.registrarFallo('ana@smi.local');
    expect(guard.restante('ana@smi.local')).toBe(0);
  });

  it('el mensaje dice cuántos minutos esperar', () => {
    expect(mensajeBloqueo(BLOQUEO_MS)).toContain('15 minutos');
    expect(mensajeBloqueo(30_000)).toContain('1 minuto ');
  });
});
