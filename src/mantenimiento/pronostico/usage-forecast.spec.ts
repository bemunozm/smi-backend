import {
  addDays,
  dailyUsageRate,
  forecastMaintenance,
  weekdayProfile,
  type UsageCard,
} from './usage-forecast';

const NOW = new Date('2026-10-24T15:00:00.000Z'); // sábado 24/10
const diasAntes = (n: number, hora = 12) =>
  new Date(
    NOW.getTime() - n * 24 * 60 * 60 * 1000 + (hora - 15) * 60 * 60 * 1000,
  );
const dia = (d: Date) => d.toISOString().slice(0, 10);

/** Una tarjeta cerrada el mismo día: de `inicial` a `inicial + uso`. */
function tarjeta(haceDias: number, inicial: number, uso: number): UsageCard {
  return {
    start: diasAntes(haceDias, 8),
    initial: inicial,
    end: diasAntes(haceDias, 20),
    final: inicial + uso,
    belowPrevious: false,
  };
}

describe('addDays', () => {
  it('suma días de calendario, cruzando meses', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
  });
});

describe('dailyUsageRate', () => {
  it('mide el avance del contador desde la primera lectura hasta hoy', () => {
    // 20 días atrás leía 1.000 h; hoy, 1.200 h → 10 h/día.
    const cards = [tarjeta(20, 1000, 10), tarjeta(1, 1190, 10)];
    const r = dailyUsageRate(cards, NOW);
    expect(r?.rate).toBeCloseTo(200 / (20 + 7 / 24), 1);
    expect(r?.spanDays).toBe(20);
  });

  it('cuenta lo usado SIN tarjeta entre medio (avance del contador, no suma de tarjetas)', () => {
    // Las tarjetas solo suman 20 km, pero el odómetro avanzó 1.000.
    const cards = [tarjeta(10, 45000, 10), tarjeta(2, 45990, 10)];
    expect(dailyUsageRate(cards, NOW)!.rate).toBeGreaterThan(90);
  });

  it('con menos de 7 días de lecturas no estima', () => {
    expect(
      dailyUsageRate([tarjeta(5, 100, 10), tarjeta(1, 150, 10)], NOW),
    ).toBeNull();
  });

  it('ignora lo anterior a 4 semanas y la lectura marcada como menor a la anterior', () => {
    const vieja = tarjeta(40, 0, 10);
    const mala: UsageCard = {
      ...tarjeta(20, 10, 0),
      belowPrevious: true,
      end: null,
      final: null,
    };
    const cards = [vieja, mala, tarjeta(14, 500, 10), tarjeta(1, 600, 10)];
    const r = dailyUsageRate(cards, NOW)!;
    expect(r.spanDays).toBe(14);
    expect(r.rate).toBeCloseTo(110 / (14 + 7 / 24), 1);
  });

  it('un contador que no avanzó da 0 (sin uso)', () => {
    expect(
      dailyUsageRate([tarjeta(10, 100, 0), tarjeta(2, 100, 0)], NOW)!.rate,
    ).toBe(0);
  });
});

describe('weekdayProfile', () => {
  it('reparte el uso por día de la semana; sin 3 semanas de historial, null', () => {
    expect(weekdayProfile([tarjeta(10, 0, 5)], NOW, dia)).toBeNull();

    // 4 semanas: se trabaja de lunes a viernes, nunca el domingo.
    const cards: UsageCard[] = [];
    for (let i = 1; i <= 28; i++) {
      const wd = diasAntes(i).getUTCDay();
      if (wd >= 1 && wd <= 5) cards.push(tarjeta(i, 0, 10));
    }
    const perfil = weekdayProfile(cards, NOW, dia)!;
    expect(perfil[0]).toBe(0); // domingo
    expect(perfil[6]).toBe(0); // sábado
    expect(perfil[1]).toBe(40);
  });

  it('una tarjeta de varios días (la camioneta) se reparte entre ellos', () => {
    const larga: UsageCard = {
      start: diasAntes(25, 9),
      initial: 0,
      end: diasAntes(24, 9),
      final: 300,
      belowPrevious: false,
    };
    const perfil = weekdayProfile([larga], NOW, dia)!;
    expect(perfil.reduce((a, b) => a + b, 0)).toBe(300);
    expect(perfil.filter((v) => v === 150)).toHaveLength(2);
  });
});

describe('forecastMaintenance', () => {
  const today = '2026-10-24'; // sábado

  it('fecha estimada = hoy + días que faltan al ritmo actual', () => {
    const f = forecastMaintenance({
      remaining: 470,
      rate: { rate: 85, spanDays: 28 },
      profile: null,
      today,
    });
    expect(f).toMatchObject({
      status: 'ESTIMADA',
      dailyUsage: 85,
      estimatedDate: '2026-10-30', // 470 / 85 = 5,5 → 6 días
      weekStart: '2026-10-24', // no antes de hoy
      suggestedDate: null,
    });
  });

  it('con historial, sugiere el día de menos uso de la semana previa', () => {
    // Domingo sin uso, el resto parejo.
    const profile = [0, 50, 50, 50, 50, 50, 20];
    const f = forecastMaintenance({
      remaining: 200,
      rate: { rate: 10, spanDays: 28 },
      profile,
      today,
    });
    expect(f.estimatedDate).toBe('2026-11-13'); // viernes, 20 días
    expect(f.weekStart).toBe('2026-11-07');
    expect(f.suggestedDate).toBe('2026-11-08'); // domingo
  });

  it('entre días iguales, el más cercano a la fecha estimada', () => {
    const f = forecastMaintenance({
      remaining: 200,
      rate: { rate: 10, spanDays: 28 },
      profile: [10, 10, 10, 10, 10, 10, 10],
      today,
    });
    expect(f.suggestedDate).toBe(f.estimatedDate);
  });

  it('estados sin fecha: faltan datos, sin uso y lejana', () => {
    expect(
      forecastMaintenance({ remaining: 10, rate: null, profile: null, today })
        .status,
    ).toBe('FALTAN_DATOS');
    expect(
      forecastMaintenance({
        remaining: 10,
        rate: { rate: 0, spanDays: 20 },
        profile: null,
        today,
      }).status,
    ).toBe('SIN_USO');
    const lejana = forecastMaintenance({
      remaining: 9000,
      rate: { rate: 5, spanDays: 20 },
      profile: null,
      today,
    });
    expect(lejana).toMatchObject({ status: 'LEJANA', estimatedDate: null });
  });

  it('si ya no falta nada, toca hoy', () => {
    expect(
      forecastMaintenance({ remaining: 0, rate: null, profile: null, today }),
    ).toMatchObject({
      status: 'TOCA_AHORA',
      estimatedDate: today,
      suggestedDate: today,
    });
  });
});
