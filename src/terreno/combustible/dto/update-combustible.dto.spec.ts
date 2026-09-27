import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateCombustibleDto } from './update-combustible.dto';

/** Mismo contrato que `CreateCombustibleDto.fotoUrl` — ver hallazgo BAJO B3
 * de la revisión de seguridad (código de Terreno). */
describe('UpdateCombustibleDto — fotoUrl', () => {
  it('acepta una ruta /uploads/<archivo> válida', async () => {
    const dto = plainToInstance(UpdateCombustibleDto, {
      fotoUrl: '/uploads/legacy.jpg',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('permite omitir fotoUrl', async () => {
    const dto = plainToInstance(UpdateCombustibleDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza una URL externa (tracking pixel disfrazado de foto)', async () => {
    const dto = plainToInstance(UpdateCombustibleDto, {
      fotoUrl: 'https://evil.com/pixel.png',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza un fotoUrl por encima de 300 caracteres', async () => {
    const dto = plainToInstance(UpdateCombustibleDto, {
      fotoUrl: `/uploads/${'a'.repeat(300)}.jpg`,
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
