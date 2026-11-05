import {
  businessDayInstant,
  businessDayKey,
  formatBusinessDate,
  formatBusinessDateTime,
  isPastBusinessDay,
  todayInBusinessTimeZone,
} from './business-time';

// Instantes fijos a ambos lados de la medianoche UTC: `Intl.DateTimeFormat`
// recibe `timeZone` explícito, así que el resultado no depende del TZ de la
// máquina que corre el test.
describe('todayInBusinessTimeZone', () => {
  it('2026-09-29T02:30:00Z sigue siendo 28 en Santiago (UTC-3 en esa fecha)', () => {
    expect(todayInBusinessTimeZone(new Date('2026-09-29T02:30:00.000Z'))).toBe(
      '2026-09-28',
    );
  });

  it('2026-09-29T12:00:00Z ya es 29 en Santiago', () => {
    expect(todayInBusinessTimeZone(new Date('2026-09-29T12:00:00.000Z'))).toBe(
      '2026-09-29',
    );
  });
});

describe('formatBusinessDate', () => {
  it('lo registrado de noche en Chile no salta al día UTC siguiente', () => {
    expect(formatBusinessDate(new Date('2026-09-29T02:30:00.000Z'))).toBe(
      '28-09-2026',
    );
  });
});

describe('businessDayInstant', () => {
  it('cae en el día pedido en verano chileno (UTC-3)', () => {
    expect(businessDayKey(businessDayInstant('2026-01-15'))).toBe('2026-01-15');
    expect(businessDayKey(businessDayInstant('2026-01-15', '20:30'))).toBe(
      '2026-01-15',
    );
  });

  it('cae en el día pedido en invierno chileno (UTC-4)', () => {
    expect(businessDayKey(businessDayInstant('2026-06-10'))).toBe('2026-06-10');
    expect(businessDayKey(businessDayInstant('2026-06-10', '20:30'))).toBe(
      '2026-06-10',
    );
  });
});

describe('isPastBusinessDay', () => {
  // 2026-11-02T15:00:00Z → día de negocio 2026-11-02 (12:00 en Santiago).
  const now = new Date('2026-11-02T15:00:00.000Z');

  it('ayer es pasado', () => {
    expect(isPastBusinessDay('2026-11-01', now)).toBe(true);
  });

  it('hoy no es pasado', () => {
    expect(isPastBusinessDay('2026-11-02', now)).toBe(false);
  });

  it('mañana no es pasado', () => {
    expect(isPastBusinessDay('2026-11-03', now)).toBe(false);
  });
});

describe('formatBusinessDateTime', () => {
  it('formatea el instante en hora de Santiago', () => {
    // 2026-09-28T15:00:00Z -> 12:00 en Santiago (UTC-3 en esa fecha).
    const result = formatBusinessDateTime(new Date('2026-09-28T15:00:00.000Z'));
    expect(result).toContain('28-09-2026');
    expect(result).toContain('12:00');
  });
});
