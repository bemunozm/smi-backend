/** Auto-prueba del helper (sin app ni BD): corre con el resto de los e2e. */
import { expectNoCreatedById, findKeyPaths } from './assert-no-internal-fields';

describe('findKeyPaths', () => {
  it('encuentra la clave en la raíz, en objetos anidados y dentro de arreglos', () => {
    const body = {
      data: {
        createdById: 'u1',
        homeBranch: { id: 'b1', createdById: 'u2' },
        stockMovements: [
          { id: 'm1' },
          { id: 'm2', item: { createdById: 'u3' } },
        ],
      },
    };

    expect(findKeyPaths(body, 'createdById')).toEqual([
      '$.data.createdById',
      '$.data.homeBranch.createdById',
      '$.data.stockMovements[1].item.createdById',
    ]);
  });

  it('no encuentra nada en una respuesta limpia ni en valores primitivos', () => {
    expect(
      findKeyPaths({ data: { id: 'a', items: [1, 'x', null] } }, 'createdById'),
    ).toEqual([]);
    expect(findKeyPaths(null, 'createdById')).toEqual([]);
    expect(findKeyPaths('createdById', 'createdById')).toEqual([]);
  });
});

describe('expectNoCreatedById', () => {
  it('falla si la clave aparece en un nivel profundo', () => {
    expect(() =>
      expectNoCreatedById({ data: { homeBranch: { createdById: null } } }),
    ).toThrow();
  });

  it('pasa con una respuesta sin la clave', () => {
    expect(() =>
      expectNoCreatedById({ data: { homeBranch: { id: 'b' } } }),
    ).not.toThrow();
  });
});
