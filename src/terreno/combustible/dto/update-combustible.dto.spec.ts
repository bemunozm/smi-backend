import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateCombustibleDto } from './update-combustible.dto';

describe('UpdateCombustibleDto', () => {
  it('acepta una corrección parcial (solo litros)', async () => {
    const dto = plainToInstance(UpdateCombustibleDto, { litros: 100.4 });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('acepta todos los campos editables juntos', async () => {
    const dto = plainToInstance(UpdateCombustibleDto, {
      litros: 120,
      tipo: 'BENCINA',
      fecha: '2026-11-01T10:00:00.000Z',
      lectura: 1534.5,
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza litros en 0 o negativos', async () => {
    expect(
      await validate(plainToInstance(UpdateCombustibleDto, { litros: 0 })),
    ).not.toHaveLength(0);
    expect(
      await validate(plainToInstance(UpdateCombustibleDto, { litros: -5 })),
    ).not.toHaveLength(0);
  });

  it('rechaza litros por encima del tope (el typo que esta edición corrige)', async () => {
    const dto = plainToInstance(UpdateCombustibleDto, { litros: 100_001 });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza un tipo de combustible desconocido', async () => {
    const dto = plainToInstance(UpdateCombustibleDto, { tipo: 'DIESEL' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza una fecha que no es ISO', async () => {
    const dto = plainToInstance(UpdateCombustibleDto, { fecha: 'ayer' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza una lectura negativa', async () => {
    const dto = plainToInstance(UpdateCombustibleDto, { lectura: -1 });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
