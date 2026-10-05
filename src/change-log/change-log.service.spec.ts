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

  it('los números se leen en formato es-CL', () => {
    interface Lectura {
      litros: number | null;
    }
    const campos: readonly ComparableField<Lectura>[] = [
      { field: 'litros', label: 'Litros' },
    ];

    expect(
      diffFields({ litros: 30.5 }, { litros: 30.75 }, campos)[0],
    ).toMatchObject({ before: '30,5', after: '30,75' });
    expect(
      diffFields({ litros: null }, { litros: 2120.5 }, campos)[0],
    ).toMatchObject({ before: '—', after: '2.120,5' });
  });

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
  it('compara por contenido, no por referencia', () => {
    expect(
      diffFields(antes, { ...antes, actividades: ['Soltar material'] }, CAMPOS),
    ).toEqual([]);
  });

  it('un texto vacío y null no son un cambio', () => {
    expect(
      diffFields(antes, { ...antes, observaciones: '  ' }, CAMPOS),
    ).toEqual([]);
  });

  /** Lo que se escribe en la base queda en el historial aunque se vea igual. */
  it('registra una diferencia menor que el redondeo de pantalla', () => {
    interface Lectura {
      litros: number;
    }
    const campos: readonly ComparableField<Lectura>[] = [
      { field: 'litros', label: 'Litros' },
    ];

    expect(
      diffFields({ litros: 30.5 }, { litros: 30.501 }, campos),
    ).toHaveLength(1);
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
