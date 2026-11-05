import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';

/**
 * Bloqueo por CUENTA de los intentos de login fallidos (pedido del 05/11).
 *
 * El rate limit de Better Auth cuenta por IP y por ruta, y en faena muchas
 * tablets salen a internet con la MISMA IP: con un límite por IP bajo, unos
 * pocos supervisores entrando en el cambio de turno (o probando cuentas) se
 * bloqueaban entre todos. El límite por IP se sube (`auth.ts`) y la
 * protección contra adivinar claves pasa a ser por cuenta: tras
 * `MAX_FALLOS` claves equivocadas seguidas, esa cuenta —y solo esa— espera
 * `BLOQUEO_MS` aunque la clave siguiente sea la correcta. Un login correcto
 * antes del tope reinicia la cuenta.
 *
 * En memoria a propósito: hay una sola instancia del backend; un reinicio
 * limpia los contadores, que es lo mismo que esperar el bloqueo.
 */
export const MAX_FALLOS = 5;
export const BLOQUEO_MS = 15 * 60 * 1000;

interface Registro {
  fallos: number;
  /** Hasta cuándo está bloqueada; 0 si no lo está. */
  bloqueadaHasta: number;
  /** Vence el registro si no hubo fallos nuevos en una ventana de bloqueo. */
  ultimoFallo: number;
}

export class LoginGuard {
  private readonly cuentas = new Map<string, Registro>();

  constructor(private readonly ahora: () => number = Date.now) {}

  private clave(email: unknown): string | null {
    return typeof email === 'string' && email.trim()
      ? email.trim().toLowerCase()
      : null;
  }

  private limpiarVencidos(t: number): void {
    for (const [clave, r] of this.cuentas) {
      if (r.bloqueadaHasta <= t && t - r.ultimoFallo > BLOQUEO_MS)
        this.cuentas.delete(clave);
    }
  }

  /** Milisegundos que le quedan de bloqueo a la cuenta; 0 si puede intentar. */
  restante(email: unknown): number {
    const clave = this.clave(email);
    if (!clave) return 0;
    const r = this.cuentas.get(clave);
    return r ? Math.max(0, r.bloqueadaHasta - this.ahora()) : 0;
  }

  registrarFallo(email: unknown): void {
    const clave = this.clave(email);
    if (!clave) return;
    const t = this.ahora();
    this.limpiarVencidos(t);
    const previo = this.cuentas.get(clave);
    // Un fallo después de un bloqueo ya cumplido parte de cero.
    const vigente =
      previo && previo.bloqueadaHasta <= t && previo.bloqueadaHasta > 0
        ? undefined
        : previo;
    const fallos = (vigente?.fallos ?? 0) + 1;
    this.cuentas.set(clave, {
      fallos,
      bloqueadaHasta: fallos >= MAX_FALLOS ? t + BLOQUEO_MS : 0,
      ultimoFallo: t,
    });
  }

  registrarExito(email: unknown): void {
    const clave = this.clave(email);
    if (clave) this.cuentas.delete(clave);
  }
}

const SIGN_IN_PATH = '/sign-in/email';

/** Mensaje en español con los minutos que faltan (redondeados hacia arriba). */
export function mensajeBloqueo(restanteMs: number): string {
  const minutos = Math.max(1, Math.ceil(restanteMs / 60_000));
  return `Demasiados intentos fallidos con esta cuenta. Espera ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'} y vuelve a intentar, o pide al administrador que revise tu clave.`;
}

/**
 * Hooks de Better Auth: `before` corta el intento de una cuenta bloqueada
 * (429 `ACCOUNT_TEMPORARILY_LOCKED`, con `Retry-After`); `after` cuenta el
 * fallo (401 de clave o correo inválidos) o limpia la cuenta si entró.
 */
export function loginGuardHooks(guard: LoginGuard) {
  // Sin nada que esperar: la promesa la pide la firma de `createAuthMiddleware`,
  // y `then` convierte el throw del bloqueo en rechazo.
  return {
    before: createAuthMiddleware((ctx) =>
      Promise.resolve().then(() => {
        if (ctx.path !== SIGN_IN_PATH) return;
        const restante = guard.restante(
          (ctx.body as { email?: unknown } | undefined)?.email,
        );
        if (restante > 0) {
          throw new APIError(
            'TOO_MANY_REQUESTS',
            {
              message: mensajeBloqueo(restante),
              code: 'ACCOUNT_TEMPORARILY_LOCKED',
            },
            { 'Retry-After': String(Math.ceil(restante / 1000)) },
          );
        }
      }),
    ),
    after: createAuthMiddleware((ctx) =>
      Promise.resolve().then(() => {
        if (ctx.path !== SIGN_IN_PATH) return;
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        const devuelto = ctx.context.returned;
        if (isAPIError(devuelto)) {
          if (devuelto.statusCode === 401) guard.registrarFallo(email);
          return;
        }
        guard.registrarExito(email);
      }),
    ),
  };
}
