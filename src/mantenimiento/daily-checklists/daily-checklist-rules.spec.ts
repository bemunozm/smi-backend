import {
  checklistProblems,
  tally,
  type RuleEntry,
  type RuleItem,
} from './daily-checklist-rules';

const CATALOGO: RuleItem[] = [
  {
    id: 'ac',
    name: 'Aire acondicionado',
    requiresPhoto: true,
    requiresTemperature: true,
  },
  {
    id: 'bocina',
    name: 'Bocinas',
    requiresPhoto: true,
    requiresTemperature: false,
  },
  {
    id: 'asiento',
    name: 'Asiento',
    requiresPhoto: false,
    requiresTemperature: false,
  },
  {
    id: 'joystick',
    name: 'Joystick',
    requiresPhoto: false,
    requiresTemperature: false,
  },
  {
    id: 'radio',
    name: 'Radio base',
    requiresPhoto: false,
    requiresTemperature: false,
  },
];

const e = (itemId: string, over: Partial<RuleEntry> = {}): RuleEntry => ({
  itemId,
  status: 'CHECKED',
  photoCount: 1,
  supplyCount: 0,
  ...over,
});

const completo = (): RuleEntry[] => [
  e('ac', { temperature: 6 }),
  e('bocina'),
  e('asiento'),
  e('joystick', { photoCount: 0 }),
  e('radio', { status: 'NOT_CHECKED', photoCount: 0 }),
];

describe('reglas del checklist diario', () => {
  it('un checklist completo se puede enviar', () => {
    expect(checklistProblems(CATALOGO, completo())).toEqual([]);
  });

  it('cuenta lo declarado, las mantenciones y las fotos', () => {
    expect(tally(completo())).toEqual({
      declared: 4,
      maintained: 0,
      photos: 3,
    });
  });

  it('un crítico que solo «Se revisó» no pide foto', () => {
    const entradas = completo().map((x) =>
      x.itemId === 'bocina' ? { ...x, photoCount: 0 } : x,
    );
    expect(checklistProblems(CATALOGO, entradas)).toEqual([]);
  });

  it('un crítico con «Se hizo mantención» exige su foto', () => {
    const entradas = completo().map((x) =>
      x.itemId === 'bocina'
        ? {
            ...x,
            status: 'MAINTAINED' as const,
            description: 'Cambio',
            photoCount: 0,
          }
        : x,
    );
    expect(checklistProblems(CATALOGO, entradas)).toContainEqual(
      'Falta la foto obligatoria de la mantención de «Bocinas».',
    );
  });

  it('una mantención de un ítem no crítico no pide foto', () => {
    const entradas = completo().map((x) =>
      x.itemId === 'asiento'
        ? {
            ...x,
            status: 'MAINTAINED' as const,
            description: 'Ajuste',
            photoCount: 0,
          }
        : x,
    );
    expect(checklistProblems(CATALOGO, entradas)).toEqual([]);
  });

  it('un crítico en «No se revisó» no exige foto', () => {
    const entradas = completo().map((x) =>
      x.itemId === 'bocina'
        ? { ...x, status: 'NOT_CHECKED' as const, photoCount: 0 }
        : x,
    );
    expect(
      checklistProblems(CATALOGO, entradas).some((p) => p.includes('Bocinas')),
    ).toBe(false);
  });

  it('el A/C declarado exige la temperatura', () => {
    const entradas = completo().map((x) =>
      x.itemId === 'ac' ? { ...x, temperature: null } : x,
    );
    expect(checklistProblems(CATALOGO, entradas)).toContainEqual(
      '«Aire acondicionado»: anota la temperatura medida.',
    );
  });

  it('«Se hizo mantención» exige descripción', () => {
    const entradas = completo().map((x) =>
      x.itemId === 'asiento'
        ? { ...x, status: 'MAINTAINED' as const, description: '' }
        : x,
    );
    expect(checklistProblems(CATALOGO, entradas)).toContainEqual(
      '«Asiento»: describe qué mantención se hizo.',
    );
  });

  it('los insumos van solo con «Se hizo mantención»', () => {
    const entradas = completo().map((x) =>
      x.itemId === 'asiento' ? { ...x, supplyCount: 1 } : x,
    );
    expect(checklistProblems(CATALOGO, entradas)).toContainEqual(
      '«Asiento»: los insumos van solo con «Se hizo mantención».',
    );
  });

  it('exige marcar todos los ítems del catálogo', () => {
    const entradas = completo().filter((x) => x.itemId !== 'radio');
    expect(checklistProblems(CATALOGO, entradas)).toContainEqual(
      'Faltan 1 ítem por marcar: Radio base.',
    );
  });

  it('todo en «No se revisó» no se puede enviar', () => {
    const entradas = CATALOGO.map((i) =>
      e(i.id, { status: 'NOT_CHECKED', photoCount: 0 }),
    );
    expect(checklistProblems(CATALOGO, entradas)).toContainEqual(
      expect.stringMatching(/No hay nada declarado/),
    );
  });
});
