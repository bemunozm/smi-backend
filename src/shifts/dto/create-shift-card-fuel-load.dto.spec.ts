import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateShiftCardFuelLoadDto } from './create-shift-card-fuel-load.dto';

const USER_ID = 'uOWvhyBv6Ir39b949hWib447vHqAjXqG'; // 32 chars, como un id real de Better Auth

function base(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    liters: 45,
    reading: 1250,
    tmpPhotoKey: `tmp/${USER_ID}/550e8400-e29b-41d4-a716-446655440000.jpg`,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function errorsOf(overrides: Record<string, unknown> = {}) {
  const dto = plainToInstance(CreateShiftCardFuelLoadDto, base(overrides));
  return (await validate(dto)).map((e) => e.property);
}

describe('CreateShiftCardFuelLoadDto', () => {
  it('acepta un body válido', async () => {
    expect(await errorsOf()).toEqual([]);
  });

  it('acepta AdBlue, foto con hora EXIF y el turno de quien carga', async () => {
    expect(
      await errorsOf({
        adBlueLiters: 10,
        photoCapturedAt: new Date().toISOString(),
        shiftDate: '2026-11-18',
        shiftType: 'NOCTURNO',
      }),
    ).toEqual([]);
  });

  it('acepta adBlueLiters null (sin AdBlue)', async () => {
    expect(await errorsOf({ adBlueLiters: null })).toEqual([]);
  });

  it('exige un id UUID v4 del cliente', async () => {
    expect(await errorsOf({ id: undefined })).toContain('id');
    expect(await errorsOf({ id: 'no-uuid' })).toContain('id');
  });

  describe('liters', () => {
    it('rechaza 0 y negativos: una carga sin litros no es carga', async () => {
      expect(await errorsOf({ liters: 0 })).toContain('liters');
      expect(await errorsOf({ liters: -5 })).toContain('liters');
    });

    it('acepta el tope (100_000) y rechaza por encima', async () => {
      expect(await errorsOf({ liters: 100_000 })).toEqual([]);
      expect(await errorsOf({ liters: 100_001 })).toContain('liters');
    });

    it('es obligatorio', async () => {
      expect(await errorsOf({ liters: undefined })).toContain('liters');
    });
  });

  describe('reading', () => {
    it('es obligatoria', async () => {
      expect(await errorsOf({ reading: undefined })).toContain('reading');
    });

    it('rechaza negativa, NaN y por encima de 1_000_000', async () => {
      expect(await errorsOf({ reading: -1 })).toContain('reading');
      expect(await errorsOf({ reading: NaN })).toContain('reading');
      expect(await errorsOf({ reading: 1_000_001 })).toContain('reading');
    });
  });

  it('rechaza AdBlue en 0 o sobre el tope', async () => {
    expect(await errorsOf({ adBlueLiters: 0 })).toContain('adBlueLiters');
    expect(await errorsOf({ adBlueLiters: 1001 })).toContain('adBlueLiters');
  });

  it('exige la foto del surtidor, con forma de key tmp', async () => {
    expect(await errorsOf({ tmpPhotoKey: undefined })).toContain('tmpPhotoKey');
    expect(await errorsOf({ tmpPhotoKey: 'fuel-photos/x.jpg' })).toContain(
      'tmpPhotoKey',
    );
  });

  it('exige capturedAt como fecha', async () => {
    expect(await errorsOf({ capturedAt: undefined })).toContain('capturedAt');
    expect(await errorsOf({ capturedAt: 'ayer' })).toContain('capturedAt');
  });

  describe('turno de quien carga', () => {
    it('shiftDate y shiftType van juntos', async () => {
      expect(await errorsOf({ shiftDate: '2026-11-18' })).toContain(
        'shiftType',
      );
      expect(await errorsOf({ shiftType: 'DIURNO' })).toContain('shiftDate');
    });

    it('rechaza una fecha inexistente o un tipo desconocido', async () => {
      expect(
        await errorsOf({ shiftDate: '2026-02-31', shiftType: 'DIURNO' }),
      ).toContain('shiftDate');
      expect(
        await errorsOf({ shiftDate: '2026-11-18', shiftType: 'TARDE' }),
      ).toContain('shiftType');
    });
  });
});
