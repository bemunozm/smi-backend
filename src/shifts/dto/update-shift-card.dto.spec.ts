import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateShiftCardDto } from './update-shift-card.dto';

async function errorsFor(body: Record<string, unknown>) {
  return validate(plainToInstance(UpdateShiftCardDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('UpdateShiftCardDto', () => {
  it('acepta un solo campo', async () => {
    expect(await errorsFor({ valorFinal: 140 })).toHaveLength(0);
  });

  it('acepta todos los campos', async () => {
    expect(
      await errorsFor({
        operatorId: 'op_1',
        valorInicial: 10,
        valorFinal: 20,
        fuelLiters: 30,
        adBlue: true,
        adBlueLiters: 15,
        observaciones: 'ok',
      }),
    ).toHaveLength(0);
  });

  it.each([
    ['valorFinal negativo', { valorFinal: -1 }],
    ['valorFinal sobre el tope', { valorFinal: 1_000_001 }],
    ['valorFinal null', { valorFinal: null }],
    ['valorInicial NaN', { valorInicial: NaN }],
    ['fuelLiters sobre 10 000', { fuelLiters: 10_001 }],
    ['fuelLiters null', { fuelLiters: null }],
    ['adBlue no booleano', { adBlue: 'si' }],
    ['adBlue null', { adBlue: null }],
    ['adBlueLiters 0', { adBlueLiters: 0 }],
    ['adBlueLiters sobre 1000', { adBlueLiters: 1001 }],
    ['operatorId numérico', { operatorId: 5 }],
    [
      'observaciones de más de 1000 caracteres',
      { observaciones: 'a'.repeat(1001) },
    ],
    ['un campo que no se edita', { equipoId: 'e1' }],
  ])('rechaza %s', async (_name, body) => {
    expect(await errorsFor(body)).not.toHaveLength(0);
  });

  it('admite null para limpiar litros de AdBlue y observaciones', async () => {
    expect(
      await errorsFor({ adBlueLiters: null, observaciones: null }),
    ).toHaveLength(0);
  });

  it('normaliza las observaciones antes de medir el límite', () => {
    const dto = plainToInstance(UpdateShiftCardDto, {
      observaciones: '  hola\r\n\r\n\r\n\r\nmundo  ',
    });
    expect(dto.observaciones).toBe('hola\n\nmundo');
  });
});
