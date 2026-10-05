import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { assertExpectedLocked } from './assert-expected-locked';

interface Fila extends Record<string, unknown> {
  id: string;
  nombre: string;
  estado: string;
}

describe('assertExpectedLocked', () => {
  const queryRaw = jest.fn();
  const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
  const read = jest.fn();

  const base = {
    tx,
    table: 'branch' as const,
    id: 'f1',
    read,
    labels: { nombre: 'Nombre', estado: 'Estado' },
    notFoundMessage: 'No existe',
  };

  beforeEach(() => {
    jest.resetAllMocks();
    queryRaw.mockResolvedValue([{ id: 'f1' }]);
    read.mockResolvedValue({ id: 'f1', nombre: 'A', estado: 'ABIERTO' });
  });

  it('bloquea ANTES de leer, también sin X-Expected', async () => {
    const orden: string[] = [];
    queryRaw.mockImplementation(() => {
      orden.push('lock');
      return Promise.resolve([{ id: 'f1' }]);
    });
    read.mockImplementation(() => {
      orden.push('read');
      return Promise.resolve({ id: 'f1', nombre: 'A', estado: 'ABIERTO' });
    });

    await assertExpectedLocked<Fila>({
      ...base,
      expected: undefined,
      desired: { nombre: 'B' },
    });

    expect(orden).toEqual(['lock', 'read']);
  });

  it('404 si la fila no se puede bloquear o no se lee', async () => {
    queryRaw.mockResolvedValue([]);
    await expect(
      assertExpectedLocked<Fila>({
        ...base,
        expected: undefined,
        desired: {},
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    queryRaw.mockResolvedValue([{ id: 'f1' }]);
    read.mockResolvedValue(null);
    await expect(
      assertExpectedLocked<Fila>({
        ...base,
        expected: undefined,
        desired: {},
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('usa el error de 404 propio cuando se lo pasan', async () => {
    queryRaw.mockResolvedValue([]);
    const propio = new NotFoundException({
      message: 'x',
      code: 'CARD_NOT_FOUND',
    });

    await expect(
      assertExpectedLocked<Fila>({
        ...base,
        expected: undefined,
        desired: {},
        notFoundError: () => propio,
      }),
    ).rejects.toBe(propio);
  });

  describe('desired derivado de la fila vigente', () => {
    it('la función recibe la fila leída bajo el bloqueo, no una lectura previa', async () => {
      // Otra persona cambió `estado` antes de que esta edición tomara el
      // bloqueo: lo que se compara y se escribe parte de ese valor.
      read.mockResolvedValue({ id: 'f1', nombre: 'A', estado: 'CERRADO' });
      const desired = jest.fn((vigente: Fila): Record<string, unknown> => ({
        nombre: 'B',
        estado: vigente.estado,
      }));

      const current = await assertExpectedLocked<Fila>({
        ...base,
        expected: { nombre: 'A' },
        desired,
      });

      expect(desired).toHaveBeenCalledWith(
        expect.objectContaining({ estado: 'CERRADO' }),
      );
      expect(current.estado).toBe('CERRADO');
    });

    it('un cambio ajeno de otro campo no da conflicto ni se pierde: el valor deseado lo conserva', async () => {
      read.mockResolvedValue({ id: 'f1', nombre: 'A', estado: 'CERRADO' });

      await expect(
        assertExpectedLocked<Fila>({
          ...base,
          // Solo se esperaba `nombre`; `estado` cambió por otro lado.
          expected: { nombre: 'A' },
          desired: (vigente) => ({ nombre: 'B', estado: vigente.estado }),
        }),
      ).resolves.toMatchObject({ estado: 'CERRADO' });
    });

    it('acepta una función asíncrona que valida y lanza antes de comparar', async () => {
      await expect(
        assertExpectedLocked<Fila>({
          ...base,
          expected: { nombre: 'ZZZ' },
          desired: () => Promise.reject(new Error('regla de negocio')),
        }),
      ).rejects.toThrow('regla de negocio');
    });

    it('409 STALE_UPDATE si el campo esperado cambió', async () => {
      read.mockResolvedValue({ id: 'f1', nombre: 'Otro', estado: 'ABIERTO' });

      await expect(
        assertExpectedLocked<Fila>({
          ...base,
          expected: { nombre: 'A' },
          desired: () => ({ nombre: 'B' }),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('comparable limita la comparación a los campos que admiten precondición', async () => {
    read.mockResolvedValue({
      id: 'f1',
      nombre: 'A',
      estado: 'ABIERTO',
      interno: 'x',
    });

    // `interno` existe en la fila pero no es comparable: se ignora aunque
    // el cliente lo mande en `X-Expected`.
    await expect(
      assertExpectedLocked<Fila>({
        ...base,
        expected: { interno: 'otro' },
        desired: { interno: 'z' },
        comparable: ({ nombre, estado }) => ({ nombre, estado }),
      }),
    ).resolves.toBeDefined();
  });

  it('con desired estático sigue funcionando como antes', async () => {
    await expect(
      assertExpectedLocked<Fila>({
        ...base,
        expected: { nombre: 'A' },
        desired: { nombre: 'B' },
      }),
    ).resolves.toMatchObject({ nombre: 'A' });
  });
});
