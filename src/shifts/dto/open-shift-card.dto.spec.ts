import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { OpenShiftCardDto } from './open-shift-card.dto';

function base(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    equipoId: 'e1',
    operatorId: 'op_1',
    valorInicial: 100,
    shiftDate: '2026-09-28',
    shiftType: 'DIURNO',
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('OpenShiftCardDto', () => {
  it('acepta un body válido', async () => {
    const dto = plainToInstance(OpenShiftCardDto, base());
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza un shiftDate que no es una fecha real', async () => {
    const dto = plainToInstance(
      OpenShiftCardDto,
      base({ shiftDate: '2026-02-31' }),
    );
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza un shiftDate con mes fuera de rango', async () => {
    const dto = plainToInstance(
      OpenShiftCardDto,
      base({ shiftDate: '2026-13-45' }),
    );
    expect(await validate(dto)).not.toHaveLength(0);
  });

  describe('valorInicial — límites', () => {
    it('rechaza negativo', async () => {
      const dto = plainToInstance(OpenShiftCardDto, base({ valorInicial: -1 }));
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('acepta 0', async () => {
      const dto = plainToInstance(OpenShiftCardDto, base({ valorInicial: 0 }));
      expect(await validate(dto)).toHaveLength(0);
    });

    it('acepta el máximo (1_000_000)', async () => {
      const dto = plainToInstance(
        OpenShiftCardDto,
        base({ valorInicial: 1_000_000 }),
      );
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rechaza por encima del máximo', async () => {
      const dto = plainToInstance(
        OpenShiftCardDto,
        base({ valorInicial: 1_000_001 }),
      );
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rechaza NaN', async () => {
      const dto = plainToInstance(
        OpenShiftCardDto,
        base({ valorInicial: NaN }),
      );
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rechaza Infinity', async () => {
      const dto = plainToInstance(
        OpenShiftCardDto,
        base({ valorInicial: Infinity }),
      );
      expect(await validate(dto)).not.toHaveLength(0);
    });
  });
});
