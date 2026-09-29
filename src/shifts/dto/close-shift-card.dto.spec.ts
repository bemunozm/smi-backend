import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CloseShiftCardDto } from './close-shift-card.dto';

const USER_ID = 'uOWvhyBv6Ir39b949hWib447vHqAjXqG'; // 32 chars, como un id real de Better Auth

function base(overrides: Record<string, unknown> = {}) {
  return {
    closeClientId: '22222222-2222-4222-8222-222222222222',
    valorFinal: 130,
    fuelLiters: 40,
    tmpPhotoKey: `tmp/${USER_ID}/550e8400-e29b-41d4-a716-446655440000.jpg`,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('CloseShiftCardDto', () => {
  it('acepta un body válido', async () => {
    const dto = plainToInstance(CloseShiftCardDto, base());
    expect(await validate(dto)).toHaveLength(0);
  });

  describe('valorFinal — límites', () => {
    it('rechaza negativo', async () => {
      const dto = plainToInstance(CloseShiftCardDto, base({ valorFinal: -1 }));
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('acepta el máximo (1_000_000)', async () => {
      const dto = plainToInstance(
        CloseShiftCardDto,
        base({ valorFinal: 1_000_000 }),
      );
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rechaza por encima del máximo', async () => {
      const dto = plainToInstance(
        CloseShiftCardDto,
        base({ valorFinal: 1_000_001 }),
      );
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('rechaza NaN e Infinity', async () => {
      const nanDto = plainToInstance(
        CloseShiftCardDto,
        base({ valorFinal: NaN }),
      );
      const infDto = plainToInstance(
        CloseShiftCardDto,
        base({ valorFinal: Infinity }),
      );
      expect(await validate(nanDto)).not.toHaveLength(0);
      expect(await validate(infDto)).not.toHaveLength(0);
    });
  });

  describe('fuelLiters — límite', () => {
    it('acepta 0', async () => {
      const dto = plainToInstance(CloseShiftCardDto, base({ fuelLiters: 0 }));
      expect(await validate(dto)).toHaveLength(0);
    });

    it('acepta el máximo (10_000)', async () => {
      const dto = plainToInstance(
        CloseShiftCardDto,
        base({ fuelLiters: 10_000 }),
      );
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rechaza por encima del máximo', async () => {
      const dto = plainToInstance(
        CloseShiftCardDto,
        base({ fuelLiters: 10_001 }),
      );
      expect(await validate(dto)).not.toHaveLength(0);
    });
  });

  describe('observaciones — normalización + límite', () => {
    it('normaliza CRLF y colapsa saltos de línea antes de validar', async () => {
      const dto = plainToInstance(
        CloseShiftCardDto,
        base({ observaciones: '  linea1\r\n\r\n\r\nlinea2  ' }),
      );
      expect(dto.observaciones).toBe('linea1\n\nlinea2');
      expect(await validate(dto)).toHaveLength(0);
    });

    it('acepta hasta 1000 caracteres (ya normalizados)', async () => {
      const dto = plainToInstance(
        CloseShiftCardDto,
        base({ observaciones: 'a'.repeat(1000) }),
      );
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rechaza más de 1000 caracteres', async () => {
      const dto = plainToInstance(
        CloseShiftCardDto,
        base({ observaciones: 'a'.repeat(1001) }),
      );
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('el límite se mide DESPUÉS de normalizar (un texto que colapsa por debajo de 1000 pasa)', async () => {
      // 1500 saltos de línea colapsan a 2 tras la normalización.
      const dto = plainToInstance(
        CloseShiftCardDto,
        base({ observaciones: '\n'.repeat(1500) }),
      );
      expect(dto.observaciones).toBe('');
      expect(await validate(dto)).toHaveLength(0);
    });

    it('es opcional', async () => {
      const dto = plainToInstance(CloseShiftCardDto, base());
      expect(await validate(dto)).toHaveLength(0);
    });
  });
});
