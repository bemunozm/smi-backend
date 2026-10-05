import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODES } from '../errors/error-codes';
import {
  createOrReturn,
  isPrimaryKeyViolation,
  resolveExisting,
} from './create-or-return';

const ID = '11111111-1111-4111-8111-111111111111';
const USER = 'user-1';

const p2002 = (target: unknown) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });

const base = () => ({
  id: ID as string | undefined,
  userId: USER,
  conflictMessage: 'conflicto',
  findExisting: jest.fn(),
  create: jest.fn(),
});

describe('createOrReturn', () => {
  it('sin id crea sin buscar nada', async () => {
    const opts = { ...base(), id: undefined };
    opts.create.mockResolvedValue('nuevo');

    await expect(createOrReturn(opts)).resolves.toBe('nuevo');
    expect(opts.findExisting).not.toHaveBeenCalled();
  });

  it('con id sin fila previa crea', async () => {
    const opts = base();
    opts.findExisting.mockResolvedValue(null);
    opts.create.mockResolvedValue('nuevo');

    await expect(createOrReturn(opts)).resolves.toBe('nuevo');
    expect(opts.create).toHaveBeenCalledTimes(1);
  });

  it('fila previa del mismo dueño: devuelve el resultado sin crear', async () => {
    const opts = base();
    opts.findExisting.mockResolvedValue({ ownerId: USER, result: 'previo' });

    await expect(createOrReturn(opts)).resolves.toBe('previo');
    expect(opts.create).not.toHaveBeenCalled();
  });

  it('fila previa de otro dueño: 409 ID_CONFLICT sin crear', async () => {
    const opts = base();
    opts.findExisting.mockResolvedValue({ ownerId: 'otro', result: 'previo' });

    const error = await createOrReturn(opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: ERROR_CODES.ID_CONFLICT,
      message: 'conflicto',
    });
    expect(opts.create).not.toHaveBeenCalled();
  });

  it('fila previa sin dueño: 409 ID_CONFLICT', async () => {
    const opts = base();
    opts.findExisting.mockResolvedValue({ ownerId: null, result: 'previo' });

    await expect(createOrReturn(opts)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('carrera sobre la PK: relee y devuelve la fila ganadora propia', async () => {
    const opts = base();
    opts.findExisting
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ownerId: USER, result: 'ganadora' });
    opts.create.mockRejectedValue(p2002(['id']));

    await expect(createOrReturn(opts)).resolves.toBe('ganadora');
    expect(opts.findExisting).toHaveBeenCalledTimes(2);
  });

  it('carrera sobre la PK con ganador ajeno: 409 ID_CONFLICT', async () => {
    const opts = base();
    opts.findExisting
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ownerId: 'otro', result: 'ganadora' });
    opts.create.mockRejectedValue(p2002(['id']));

    const error = await createOrReturn(opts).catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: ERROR_CODES.ID_CONFLICT,
    });
  });

  it('carrera sobre la PK con el nombre del constraint también se reconoce', async () => {
    const opts = base();
    opts.findExisting
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ownerId: USER, result: 'ganadora' });
    opts.create.mockRejectedValue(p2002('equipment_pkey'));

    await expect(createOrReturn(opts)).resolves.toBe('ganadora');
  });

  it('P2002 sobre otra columna sin fila ganadora: relanza el error original', async () => {
    const opts = base();
    opts.findExisting.mockResolvedValue(null);
    const original = p2002(['internal_code']);
    opts.create.mockRejectedValue(original);

    await expect(createOrReturn(opts)).rejects.toBe(original);
    // Una relectura barata en el camino de error: no hay ganadora, así que
    // el error de negocio sigue su camino.
    expect(opts.findExisting).toHaveBeenCalledTimes(2);
  });

  it('P2002 sobre la PK sin fila visible relanza el error original', async () => {
    const opts = base();
    opts.findExisting.mockResolvedValue(null);
    const original = p2002(['id']);
    opts.create.mockRejectedValue(original);

    await expect(createOrReturn(opts)).rejects.toBe(original);
  });

  describe('cualquier error del create con id relee a la ganadora', () => {
    it('una regla de negocio perdida contra la ganadora (INSUFFICIENT_STOCK) devuelve la fila propia ya aplicada', async () => {
      const opts = base();
      opts.findExisting
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ownerId: USER, result: 'asiento-ganador' });
      opts.create.mockRejectedValue(
        new ConflictException({
          message: 'sin existencia',
          code: ERROR_CODES.INSUFFICIENT_STOCK,
        }),
      );

      await expect(createOrReturn(opts)).resolves.toBe('asiento-ganador');
    });

    it('un error cualquiera con ganadora ajena: 409 ID_CONFLICT', async () => {
      const opts = base();
      opts.findExisting
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ownerId: 'otro', result: 'ajeno' });
      opts.create.mockRejectedValue(new Error('boom'));

      const error = await createOrReturn(opts).catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: ERROR_CODES.ID_CONFLICT,
      });
    });

    it('un error cualquiera sin fila ganadora se relanza tal cual', async () => {
      const opts = base();
      opts.findExisting.mockResolvedValue(null);
      const original = new Error('boom');
      opts.create.mockRejectedValue(original);

      await expect(createOrReturn(opts)).rejects.toBe(original);
      expect(opts.findExisting).toHaveBeenCalledTimes(2);
    });

    it('si la relectura también falla se propaga el error ORIGINAL del create', async () => {
      const opts = base();
      opts.findExisting
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('relectura caída'));
      const original = new Error('boom');
      opts.create.mockRejectedValue(original);

      await expect(createOrReturn(opts)).rejects.toBe(original);
    });

    it('sin id no hay relectura: el error se relanza', async () => {
      const opts = { ...base(), id: undefined };
      const original = new Error('boom');
      opts.create.mockRejectedValue(original);

      await expect(createOrReturn(opts)).rejects.toBe(original);
      expect(opts.findExisting).not.toHaveBeenCalled();
    });
  });
});

describe('resolveExisting', () => {
  it('entrega el resultado (valor o función) si la fila es del usuario', async () => {
    await expect(
      resolveExisting({ ownerId: USER, result: 'a' }, USER, 'x'),
    ).resolves.toBe('a');
    await expect(
      resolveExisting(
        { ownerId: USER, result: () => Promise.resolve('b') },
        USER,
        'x',
      ),
    ).resolves.toBe('b');
  });

  it('409 ID_CONFLICT con el mensaje dado si es de otro', async () => {
    const result = jest.fn();

    const error = await resolveExisting(
      { ownerId: 'otro', result },
      USER,
      'mensaje',
    ).catch((e: unknown) => e);

    expect((error as ConflictException).getResponse()).toMatchObject({
      code: ERROR_CODES.ID_CONFLICT,
      message: 'mensaje',
    });
    expect(result).not.toHaveBeenCalled();
  });
});

describe('isPrimaryKeyViolation', () => {
  it('rechaza un P2002 compuesto que incluye id', () => {
    expect(isPrimaryKeyViolation(p2002(['item_id', 'branch_id']))).toBe(false);
  });

  it('rechaza errores que no son de Prisma', () => {
    expect(isPrimaryKeyViolation(new Error('x'))).toBe(false);
  });
});
