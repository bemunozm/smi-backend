import { ConflictException } from '@nestjs/common';

import { resolveCloseRace } from './resolve-close-race';

describe('resolveCloseRace', () => {
  const alreadyClosed = () => new ConflictException('ya cerrada');

  it('mismo closeClientId en esta tarjeta: devuelve la respuesta del reintento', async () => {
    const replay = jest.fn().mockResolvedValue('cerrada');

    await expect(
      resolveCloseRace({
        existing: { closeClientId: 'c1', valorFinal: 130 },
        closeClientId: 'c1',
        replay,
        alreadyClosed,
      }),
    ).resolves.toBe('cerrada');
  });

  it('tarjeta aún abierta: el id de cierre lo usó otra tarjeta (ID_CONFLICT)', async () => {
    await expect(
      resolveCloseRace({
        existing: { closeClientId: null, valorFinal: null },
        closeClientId: 'c1',
        replay: jest.fn(),
        alreadyClosed,
      }),
    ).rejects.toMatchObject({ response: { code: 'ID_CONFLICT' } });
  });

  it('tarjeta cerrada con otro id de cierre: ya estaba cerrada', async () => {
    await expect(
      resolveCloseRace({
        existing: { closeClientId: 'otro', valorFinal: 130 },
        closeClientId: 'c1',
        replay: jest.fn(),
        alreadyClosed,
      }),
    ).rejects.toThrow('ya cerrada');
  });

  it('tarjeta inexistente: cae en «ya cerrada» con el error del flujo', async () => {
    await expect(
      resolveCloseRace({
        existing: null,
        closeClientId: 'c1',
        replay: jest.fn(),
        alreadyClosed,
      }),
    ).rejects.toThrow('ya cerrada');
  });
});
