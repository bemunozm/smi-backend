import { documentAlertKind, nextLightService } from './vencimientos-rules';

describe('nextLightService (mantención de livianos cada 10.000 km)', () => {
  it('toca en el siguiente múltiplo de 10.000', () => {
    expect(nextLightService(23_500)).toEqual({
      nextKm: 30_000,
      remainingKm: 6_500,
      due: false,
    });
  });

  it('avisa a 1.000 km o menos', () => {
    expect(nextLightService(29_000)?.due).toBe(true);
    expect(nextLightService(28_999)?.due).toBe(false);
  });

  it('justo en el múltiplo, toca ahora', () => {
    expect(nextLightService(30_000)).toEqual({
      nextKm: 30_000,
      remainingKm: 0,
      due: true,
    });
  });

  it('un vehículo nuevo apunta a los primeros 10.000 km', () => {
    expect(nextLightService(0)?.nextKm).toBe(10_000);
  });

  it('sin lectura del odómetro no hay cálculo', () => {
    expect(nextLightService(null)).toBeNull();
  });

  it('con último servicio registrado, toca 10.000 km después de él', () => {
    expect(nextLightService(41_200, 10_000, 1_000, 33_500)).toEqual({
      nextKm: 43_500,
      remainingKm: 2_300,
      due: false,
    });
  });

  it('con último servicio registrado y pasado de largo, lo pendiente es negativo', () => {
    expect(nextLightService(44_000, 10_000, 1_000, 33_500)).toEqual({
      nextKm: 43_500,
      remainingKm: -500,
      due: true,
    });
  });

  it('sin último servicio sigue el múltiplo de 10.000', () => {
    expect(nextLightService(41_200, 10_000, 1_000, null)).toEqual({
      nextKm: 50_000,
      remainingKm: 8_800,
      due: false,
    });
  });
});

describe('documentAlertKind', () => {
  const hoy = new Date('2026-10-19T15:00:00.000Z');
  const en = (dias: number) => new Date(Date.UTC(2026, 9, 19 + dias));

  it('dentro del plazo de anticipación del documento: POR_VENCER', () => {
    expect(documentAlertKind(en(45), 45, hoy)).toBe('POR_VENCER');
    expect(documentAlertKind(en(46), 45, hoy)).toBeNull();
  });

  it('el mismo día del vencimiento sigue POR_VENCER; al día siguiente, VENCIDO', () => {
    expect(documentAlertKind(en(0), 30, hoy)).toBe('POR_VENCER');
    expect(documentAlertKind(en(-1), 30, hoy)).toBe('VENCIDO');
  });

  it('sin fecha de vencimiento no avisa', () => {
    expect(documentAlertKind(null, 30, hoy)).toBeNull();
  });
});
