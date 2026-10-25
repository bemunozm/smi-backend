/**
 * Fecha estimada de la próxima mantención según el uso real del equipo
 * (RFC `docs/rfc/RFC-pronostico-mantencion.md`). Funciones puras: el servicio
 * les pasa las lecturas de las tarjetas de turno y el día de hoy.
 *
 * Los pesados se miden en horas máquina (horómetro) y los livianos en km
 * (odómetro): acá da lo mismo, todo es «contador».
 */

/** Ventana del uso promedio: las últimas 4 semanas. */
export const RATE_WINDOW_DAYS = 28;
/** Con menos días de lecturas no se estima: el promedio no dice nada. */
export const MIN_RATE_SPAN_DAYS = 7;
/** Ventana del reparto por día de la semana (8 semanas). */
export const PROFILE_WINDOW_DAYS = 56;
/** Con menos historial no se elige día: solo se muestra la semana. */
export const MIN_PROFILE_SPAN_DAYS = 21;
/** Más allá, la fecha no sirve para planificar. */
export const MAX_FORECAST_DAYS = 365;
/** El día sugerido se busca en los 7 días que terminan en la fecha estimada. */
export const SUGGESTION_WINDOW_DAYS = 7;

const DIA_MS = 24 * 60 * 60 * 1000;

/** Una tarjeta de turno: lectura al abrir y, si se cerró, al cerrar. */
export interface UsageCard {
  start: Date;
  initial: number;
  end: Date | null;
  final: number | null;
  /** La lectura inicial fue menor que el contador vigente: no cuenta. */
  belowPrevious: boolean;
}

export type ForecastStatus =
  'ESTIMADA' | 'TOCA_AHORA' | 'FALTAN_DATOS' | 'SIN_USO' | 'LEJANA';

export interface Forecast {
  status: ForecastStatus;
  /** Uso por día (h o km), redondeado a una décima. */
  dailyUsage: number | null;
  /** Días de lecturas en que se basa el promedio. */
  basedOnDays: number | null;
  /** `YYYY-MM-DD` en que llegaría a la mantención a este ritmo. */
  estimatedDate: string | null;
  /** Primer día de la semana que termina en la fecha estimada (no antes de hoy). */
  weekStart: string | null;
  /** El día de esa semana en que el equipo menos se usa, si hay historial. */
  suggestedDate: string | null;
}

const decima = (n: number) => Math.round(n * 10) / 10;

/** `YYYY-MM-DD` + `n` días (calendario puro, sin husos). */
export function addDays(dia: string, n: number): string {
  const [y, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Días de calendario entre dos `YYYY-MM-DD`. */
function diasEntre(desde: string, hasta: string): number {
  return Math.round(
    (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) /
      DIA_MS,
  );
}

/** 0 = domingo … 6 = sábado. */
function diaSemana(dia: string): number {
  return new Date(`${dia}T00:00:00Z`).getUTCDay();
}

/**
 * Uso promedio por día: cuánto avanzó el contador en las últimas 4 semanas,
 * dividido por los días desde la primera lectura de esa ventana hasta hoy.
 * Mide el avance del horómetro u odómetro, no la suma de las tarjetas: así
 * cuenta también lo que se usó sin tarjeta y los días sin uso.
 */
export function dailyUsageRate(
  cards: readonly UsageCard[],
  now: Date,
): { rate: number; spanDays: number } | null {
  const desde = now.getTime() - RATE_WINDOW_DAYS * DIA_MS;
  const puntos: { t: number; v: number }[] = [];
  for (const c of cards) {
    if (!c.belowPrevious) puntos.push({ t: c.start.getTime(), v: c.initial });
    if (c.end && c.final != null)
      puntos.push({ t: c.end.getTime(), v: c.final });
  }
  const enVentana = puntos
    .filter((p) => p.t >= desde && p.t <= now.getTime())
    .sort((a, b) => a.t - b.t);
  if (enVentana.length < 2) return null;

  const primero = enVentana[0];
  const spanDays = (now.getTime() - primero.t) / DIA_MS;
  if (spanDays < MIN_RATE_SPAN_DAYS) return null;

  const maximo = Math.max(...enVentana.map((p) => p.v));
  return {
    rate: Math.max(0, maximo - primero.v) / spanDays,
    spanDays: Math.floor(spanDays),
  };
}

/**
 * Cuánto se usa el equipo cada día de la semana (índice 0 = domingo), con las
 * tarjetas cerradas de las últimas 8 semanas. Una tarjeta que dura varios días
 * (la camioneta que se cierra al cargar combustible) se reparte entre ellos.
 * `dayOf` da el día de negocio (`YYYY-MM-DD`, hora de Chile) de un instante.
 */
export function weekdayProfile(
  cards: readonly UsageCard[],
  now: Date,
  dayOf: (d: Date) => string,
): number[] | null {
  const desde = now.getTime() - PROFILE_WINDOW_DAYS * DIA_MS;
  const perfil = [0, 0, 0, 0, 0, 0, 0];
  let primero: number | null = null;

  for (const c of cards) {
    if (
      c.start.getTime() < desde ||
      !c.end ||
      c.final == null ||
      c.belowPrevious
    )
      continue;
    const uso = c.final - c.initial;
    if (uso <= 0) continue;
    primero = Math.min(primero ?? c.start.getTime(), c.start.getTime());
    const inicio = dayOf(c.start);
    const dias = diasEntre(inicio, dayOf(c.end)) + 1;
    for (let i = 0; i < dias; i++)
      perfil[diaSemana(addDays(inicio, i))] += uso / dias;
  }

  if (
    primero == null ||
    (now.getTime() - primero) / DIA_MS < MIN_PROFILE_SPAN_DAYS
  )
    return null;
  return perfil;
}

/**
 * Fecha estimada y día sugerido. `remaining` es lo que falta para la próxima
 * mantención (h o km); `today`, el día de hoy en Chile.
 */
export function forecastMaintenance(params: {
  remaining: number;
  rate: { rate: number; spanDays: number } | null;
  profile: number[] | null;
  today: string;
}): Forecast {
  const { remaining, rate, profile, today } = params;
  const base = {
    dailyUsage: rate ? decima(rate.rate) : null,
    basedOnDays: rate?.spanDays ?? null,
    estimatedDate: null,
    weekStart: null,
    suggestedDate: null,
  };

  if (remaining <= 0) {
    return {
      ...base,
      status: 'TOCA_AHORA',
      estimatedDate: today,
      weekStart: today,
      suggestedDate: today,
    };
  }
  if (!rate) return { ...base, status: 'FALTAN_DATOS' };
  if (rate.rate <= 0) return { ...base, status: 'SIN_USO' };

  const dias = Math.ceil(remaining / rate.rate);
  if (dias > MAX_FORECAST_DAYS) return { ...base, status: 'LEJANA' };

  const estimatedDate = addDays(today, dias);
  const weekStart = addDays(
    today,
    Math.max(0, dias - (SUGGESTION_WINDOW_DAYS - 1)),
  );

  let suggestedDate: string | null = null;
  if (profile) {
    // El de menos uso; entre iguales, el más cercano a la fecha estimada
    // (no adelantar la mantención sin necesidad).
    for (let dia = weekStart; dia <= estimatedDate; dia = addDays(dia, 1)) {
      if (
        suggestedDate == null ||
        profile[diaSemana(dia)] <= profile[diaSemana(suggestedDate)]
      ) {
        suggestedDate = dia;
      }
    }
  }

  return {
    ...base,
    status: 'ESTIMADA',
    estimatedDate,
    weekStart,
    suggestedDate,
  };
}
