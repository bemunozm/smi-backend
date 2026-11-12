import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RegisterClosedShiftCardDto } from './register-closed-shift-card.dto';

function base(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    equipoId: 'e1',
    operatorId: 'op_1',
    valorInicial: 100,
    valorFinal: 110,
    shiftDate: '2026-11-01',
    shiftType: 'DIURNO',
    capturedAt: new Date().toISOString(),
    closeClientId: '22222222-2222-4222-8222-222222222222',
    fuelLiters: 60,
    tmpPhotoKey: 'tmp/abcDEF1234567890/33333333-3333-4333-8333-333333333333.jpg',
    ...overrides,
  };
}

describe('RegisterClosedShiftCardDto', () => {
  it('acepta un body válido', async () => {
    const dto = plainToInstance(RegisterClosedShiftCardDto, base());
    expect(await validate(dto)).toHaveLength(0);
  });

  it('acepta 0 litros (equipo sin carga ese turno)', async () => {
    const dto = plainToInstance(RegisterClosedShiftCardDto, base({ fuelLiters: 0 }));
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza litros por encima del tope', async () => {
    const dto = plainToInstance(
      RegisterClosedShiftCardDto,
      base({ fuelLiters: 100_001 }),
    );
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza una tmpPhotoKey que no es key tmp', async () => {
    const dto = plainToInstance(
      RegisterClosedShiftCardDto,
      base({ tmpPhotoKey: 'no-es-una-key' }),
    );
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza un shiftDate que no es una fecha real', async () => {
    const dto = plainToInstance(
      RegisterClosedShiftCardDto,
      base({ shiftDate: '2026-02-31' }),
    );
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza valorFinal negativo', async () => {
    const dto = plainToInstance(
      RegisterClosedShiftCardDto,
      base({ valorFinal: -1 }),
    );
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza adBlue true sin litros de AdBlue', async () => {
    const dto = plainToInstance(
      RegisterClosedShiftCardDto,
      base({ adBlue: true }),
    );
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('acepta adBlue true con sus litros', async () => {
    const dto = plainToInstance(
      RegisterClosedShiftCardDto,
      base({ adBlue: true, adBlueLiters: 10 }),
    );
    expect(await validate(dto)).toHaveLength(0);
  });
});
