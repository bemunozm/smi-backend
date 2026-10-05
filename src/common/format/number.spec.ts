import { formatNumber } from './number';

describe('formatNumber', () => {
  it.each([
    [30.5, '30,5'],
    [30.75, '30,75'],
    [2120.5, '2.120,5'],
    [1212, '1.212'],
    [1000000, '1.000.000'],
    [0, '0'],
    [12.345, '12,35'],
    [-1500.25, '-1.500,25'],
  ])('%p -> %s', (value, expected) => {
    expect(formatNumber(value)).toBe(expected);
  });

  it('no inventa formato para lo que no es un número finito', () => {
    expect(formatNumber(Number.NaN)).toBe('NaN');
    expect(formatNumber(Infinity)).toBe('Infinity');
  });
});
