/**
 * Solo la lógica pura de `create-admin.ts` (validación del entorno y la regla
 * "solo el primer ADMIN") con dependencias falsas — `main()` toca Prisma y
 * Better Auth reales y se verifica en vivo contra el stack de Docker.
 */
import {
  type AdminInput,
  CreateAdminUsageError,
  createFirstAdmin,
  readAdminInput,
} from './create-admin';
import { MIN_PASSWORD_LENGTH } from './set-password';

const VALID_ENV = {
  ADMIN_EMAIL: 'admin@empresa.cl',
  ADMIN_NAME: 'Admin Empresa',
  ADMIN_PASSWORD: 'una-clave-larga-123',
};

describe('readAdminInput', () => {
  it('lee email, nombre y contraseña del entorno', () => {
    expect(readAdminInput(VALID_ENV)).toEqual({
      email: 'admin@empresa.cl',
      name: 'Admin Empresa',
      password: 'una-clave-larga-123',
    });
  });

  it('recorta espacios del email y el nombre, pero no toca la contraseña', () => {
    const input = readAdminInput({
      ADMIN_EMAIL: '  admin@empresa.cl ',
      ADMIN_NAME: ' Admin Empresa ',
      ADMIN_PASSWORD: ' con espacios ',
    });

    expect(input.email).toBe('admin@empresa.cl');
    expect(input.name).toBe('Admin Empresa');
    expect(input.password).toBe(' con espacios ');
  });

  it.each(['ADMIN_EMAIL', 'ADMIN_NAME', 'ADMIN_PASSWORD'])(
    'rechaza si falta %s, nombrándola',
    (name) => {
      const environment: Record<string, string | undefined> = {
        ...VALID_ENV,
        [name]: undefined,
      };

      expect(() => readAdminInput(environment)).toThrow(CreateAdminUsageError);
      expect(() => readAdminInput(environment)).toThrow(new RegExp(name));
    },
  );

  it('rechaza valores vacíos o solo espacios', () => {
    expect(() => readAdminInput({ ...VALID_ENV, ADMIN_NAME: '   ' })).toThrow(
      /ADMIN_NAME/,
    );
    expect(() => readAdminInput({ ...VALID_ENV, ADMIN_EMAIL: '' })).toThrow(
      /ADMIN_EMAIL/,
    );
  });

  it('lista todas las variables faltantes juntas', () => {
    expect(() => readAdminInput({})).toThrow(
      /ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD/,
    );
  });

  it('rechaza un correo inválido', () => {
    expect(() =>
      readAdminInput({ ...VALID_ENV, ADMIN_EMAIL: 'no-es-un-correo' }),
    ).toThrow(/ADMIN_EMAIL/);
  });

  it('rechaza una contraseña bajo el mínimo del repo', () => {
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);

    expect(() =>
      readAdminInput({ ...VALID_ENV, ADMIN_PASSWORD: short }),
    ).toThrow(/ADMIN_PASSWORD/);
  });

  it('acepta una contraseña exactamente en el mínimo', () => {
    const exact = 'a'.repeat(MIN_PASSWORD_LENGTH);

    expect(
      readAdminInput({ ...VALID_ENV, ADMIN_PASSWORD: exact }).password,
    ).toBe(exact);
  });

  it('el mensaje de error nunca incluye la contraseña', () => {
    const attempt = (): AdminInput =>
      readAdminInput({ ...VALID_ENV, ADMIN_PASSWORD: 'corta' });

    expect(attempt).toThrow(CreateAdminUsageError);
    expect(attempt).not.toThrow(/corta/);
  });
});

describe('createFirstAdmin', () => {
  const input: AdminInput = {
    email: 'admin@empresa.cl',
    name: 'Admin Empresa',
    password: 'una-clave-larga-123',
  };

  it('crea el admin cuando todavía no hay ninguno', async () => {
    const createAdmin = jest.fn().mockResolvedValue({ email: input.email });

    const result = await createFirstAdmin(
      { countAdmins: () => Promise.resolve(0), createAdmin },
      input,
    );

    expect(result).toEqual({ email: input.email });
    expect(createAdmin).toHaveBeenCalledWith(input);
  });

  it('se niega y no crea nada si ya existe un ADMIN', async () => {
    const createAdmin = jest.fn();

    await expect(
      createFirstAdmin(
        { countAdmins: () => Promise.resolve(1), createAdmin },
        input,
      ),
    ).rejects.toThrow(CreateAdminUsageError);
    expect(createAdmin).not.toHaveBeenCalled();
  });

  it('propaga un fallo inesperado de la creación sin enmascararlo', async () => {
    const boom = new Error('db down');

    await expect(
      createFirstAdmin(
        {
          countAdmins: () => Promise.resolve(0),
          createAdmin: () => Promise.reject(boom),
        },
        input,
      ),
    ).rejects.toBe(boom);
  });
});
