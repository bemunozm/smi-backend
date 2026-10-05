import { diffFields, type ComparableField } from './change-log.service';

interface Registro {
  operador: string;
  actividades: string[];
  observaciones: string | null;
}

const CAMPOS: readonly ComparableField<Registro>[] = [
  { field: 'operador', label: 'Operador' },
  {
    field: 'actividades',
    label: 'Actividades',
    format: (v) => (v as string[]).join(', '),
  },
  { field: 'observaciones', label: 'Observaciones' },
];

describe('diffFields', () => {
  const antes: Registro = {
    operador: 'Juan Rojas',
    actividades: ['Soltar material'],
    observaciones: null,
  };

  it('devuelve solo los campos que cambiaron, con su antes y después', () => {
    expect(
      diffFields(antes, { ...antes, operador: 'Pedro Soto' }, CAMPOS),
    ).toEqual([
      {
        field: 'operador',
        label: 'Operador',
        before: 'Juan Rojas',
        after: 'Pedro Soto',
      },
    ]);
  });

  /** Un arreglo nuevo con lo mismo no es un cambio para quien lee el registro. */
  it('compara el valor legible, no la referencia', () => {
    expect(
      diffFields(antes, { ...antes, actividades: ['Soltar material'] }, CAMPOS),
    ).toEqual([]);
  });

  it('muestra un campo vacío como «—»', () => {
    expect(
      diffFields(antes, { ...antes, observaciones: 'Pinchazo' }, CAMPOS),
    ).toEqual([
      {
        field: 'observaciones',
        label: 'Observaciones',
        before: '—',
        after: 'Pinchazo',
      },
    ]);
  });
});
