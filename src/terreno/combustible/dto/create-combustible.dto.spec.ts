import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateCombustibleDto } from './create-combustible.dto';

const base = {
  equipoId: 'e1',
  litros: 30,
  tipo: 'PETROLEO',
};

/**
 * Hallazgo BAJO B3 de la revisión de seguridad (código de Terreno): antes
 * `fotoUrl` aceptaba cualquier string — una URL externa quedaba guardada y
 * se renderizaba tal cual como `<img src>` en el listado, un tracking pixel
 * disfrazado de foto de carga. Ahora solo acepta una ruta relativa propia
 * `/uploads/<archivo>`.
 */
describe('CreateCombustibleDto — fotoUrl', () => {
  it('acepta una ruta /uploads/<archivo> válida', async () => {
    const dto = plainToInstance(CreateCombustibleDto, {
      ...base,
      fotoUrl: '/uploads/1790255460594-550696873.jpg',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('permite omitir fotoUrl', async () => {
    const dto = plainToInstance(CreateCombustibleDto, { ...base });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza una URL externa (tracking pixel disfrazado de foto)', async () => {
    const dto = plainToInstance(CreateCombustibleDto, {
      ...base,
      fotoUrl: 'https://evil.com/pixel.png',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza un protocol-relative URL (//evil.com/x.png)', async () => {
    const dto = plainToInstance(CreateCombustibleDto, {
      ...base,
      fotoUrl: '//evil.com/x.png',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza traversal disfrazado de ruta', async () => {
    const dto = plainToInstance(CreateCombustibleDto, {
      ...base,
      fotoUrl: '/uploads/../../etc/passwd',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza una ruta fuera de /uploads', async () => {
    const dto = plainToInstance(CreateCombustibleDto, {
      ...base,
      fotoUrl: '/otra-carpeta/x.jpg',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza un fotoUrl por encima de 300 caracteres', async () => {
    const dto = plainToInstance(CreateCombustibleDto, {
      ...base,
      fotoUrl: `/uploads/${'a'.repeat(300)}.jpg`,
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
