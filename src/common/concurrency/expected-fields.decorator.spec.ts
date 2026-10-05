import { BadRequestException } from '@nestjs/common';

import { runParamDecorator } from '../testing/param-decorator';
import { ExpectedFields } from './expected-fields.decorator';

const read = (headers: Record<string, string | string[] | undefined>) =>
  runParamDecorator(ExpectedFields, { headers });

describe('@ExpectedFields()', () => {
  it('sin header no hay precondición', () => {
    expect(read({})).toBeUndefined();
  });

  it('entrega el objeto ya parseado', () => {
    const header = encodeURIComponent('{"prioridad":"ALTA","tags":["a"]}');

    expect(read({ 'x-expected': header })).toEqual({
      prioridad: 'ALTA',
      tags: ['a'],
    });
  });

  it('un header mal formado es 400', () => {
    expect(() => read({ 'x-expected': 'no-es-json' })).toThrow(
      BadRequestException,
    );
  });

  it('un valor anidado es 400', () => {
    expect(() =>
      read({ 'x-expected': encodeURIComponent('{"a":{"b":1}}') }),
    ).toThrow(BadRequestException);
  });

  it('un header repetido no se ignora: queda inválido y es 400', () => {
    const uno = encodeURIComponent('{"a":1}');

    expect(() => read({ 'x-expected': [uno, uno] })).toThrow(
      BadRequestException,
    );
  });
});
