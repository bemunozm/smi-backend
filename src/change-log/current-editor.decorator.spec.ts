import { UnauthorizedException } from '@nestjs/common';

import { runParamDecorator } from '../common/testing/param-decorator';
import { CurrentEditor, toEditor } from './current-editor.decorator';

describe('toEditor', () => {
  it('usa el nombre recortado', () => {
    expect(
      toEditor({ id: 'u1', name: '  Ana Soto ', email: 'ana@smi.local' }),
    ).toEqual({ id: 'u1', name: 'Ana Soto' });
  });

  it('sin nombre usa el correo', () => {
    expect(toEditor({ id: 'u1', name: '   ', email: 'ana@smi.local' })).toEqual(
      {
        id: 'u1',
        name: 'ana@smi.local',
      },
    );
  });
});

describe('@CurrentEditor()', () => {
  it('deriva { id, name } de la sesión, no del body', () => {
    const request = {
      session: { user: { id: 'u1', name: 'Ana', email: 'a@smi.local' } },
      body: { editor: { id: 'otro', name: 'Otro' } },
    };

    expect(runParamDecorator(CurrentEditor, request)).toEqual({
      id: 'u1',
      name: 'Ana',
    });
  });

  it('sin sesión es 401', () => {
    expect(() => runParamDecorator(CurrentEditor, {})).toThrow(
      UnauthorizedException,
    );
  });
});
