import type { Content, Table } from 'pdfmake/interfaces';

import {
  buildShiftExitReportDocDefinition,
  formatShiftDateEs,
  formatShiftTypeEs,
  type ShiftReportCardInput,
} from './shift-report.pdf';

const CARD: ShiftReportCardInput = {
  equipoInternalCode: 'EX-001',
  equipoType: 'Excavadora',
  operatorName: 'Pedro Pérez',
  valorInicial: 100,
  valorFinal: 108.5,
  horasMaquina: 8.5,
  fuelLiters: 40,
  adBlue: true,
  adBlueLiters: 12.5,
  observaciones: null,
};

describe('formatShiftDateEs', () => {
  it('formatea YYYY-MM-DD a DD-MM-YYYY sin pasar por Date (nunca se corre de día)', () => {
    // El caso concreto que motivó la regla: `new Date('2026-09-28')` es
    // medianoche UTC, que en America/Santiago (UTC-3/UTC-4) es 27/09 —
    // formatear a través de un Date + formatter de tz mostraría "27-09-2026".
    expect(formatShiftDateEs('2026-09-28')).toBe('28-09-2026');
  });

  it('rechaza un formato inválido', () => {
    expect(() => formatShiftDateEs('28-09-2026')).toThrow();
  });
});

describe('formatShiftTypeEs', () => {
  it('DIURNO -> Diurno, NOCTURNO -> Nocturno', () => {
    expect(formatShiftTypeEs('DIURNO')).toBe('Diurno');
    expect(formatShiftTypeEs('NOCTURNO')).toBe('Nocturno');
  });
});

describe('buildShiftExitReportDocDefinition', () => {
  it('es una función pura: no lanza ni toca IO, mismo input mismo output', () => {
    const input = {
      shiftDate: '2026-09-28',
      shiftType: 'DIURNO',
      supervisorName: 'Ana Soto',
      generatedAt: new Date('2026-09-28T20:00:00.000Z'),
      requestedAt: new Date('2026-09-28T19:55:00.000Z'),
      cards: [CARD],
    };

    const a = buildShiftExitReportDocDefinition(input);
    const b = buildShiftExitReportDocDefinition(input);
    // `footer` es una función nueva en cada llamada (misma lógica, distinta
    // referencia) — Jest compara funciones por identidad en `toEqual`, así
    // que se excluye acá y se verifica su comportamiento aparte (ver el test
    // "el footer arma...").
    expect({ ...a, footer: undefined }).toEqual({ ...b, footer: undefined });
  });

  it('incluye el masthead y el título del reporte', () => {
    const doc = buildShiftExitReportDocDefinition({
      shiftDate: '2026-09-28',
      shiftType: 'DIURNO',
      supervisorName: 'Ana Soto',
      generatedAt: new Date(),
      requestedAt: new Date(),
      cards: [CARD],
    });

    const content = doc.content as Content[];
    expect(content[0]).toMatchObject({ text: 'TRANSPORTES OPTIMIZA SPA' });
    expect(content[1]).toMatchObject({ text: 'Reporte de salida de turno' });
  });

  it('fija defaultStyle.font en Helvetica (sin esto pdfmake usaría Roboto, que no existe en el diccionario del renderer)', () => {
    const doc = buildShiftExitReportDocDefinition({
      shiftDate: '2026-09-28',
      shiftType: 'DIURNO',
      supervisorName: 'Ana Soto',
      generatedAt: new Date(),
      requestedAt: new Date(),
      cards: [CARD],
    });

    expect(doc.defaultStyle?.font).toBe('Helvetica');
  });

  it('la tabla muestra "En curso" para una tarjeta sin valorFinal', () => {
    const openCard: ShiftReportCardInput = {
      ...CARD,
      valorFinal: null,
      horasMaquina: null,
      fuelLiters: null,
      adBlue: false,
      adBlueLiters: null,
    };
    const doc = buildShiftExitReportDocDefinition({
      shiftDate: '2026-09-28',
      shiftType: 'DIURNO',
      supervisorName: 'Ana Soto',
      generatedAt: new Date(),
      requestedAt: new Date(),
      cards: [openCard],
    });

    const content = doc.content as Content[];
    const tableContent = content.find(
      (c): c is Content & { table: Table } =>
        typeof c === 'object' && c !== null && 'table' in c,
    );
    expect(tableContent).toBeDefined();
    const dataRow = tableContent!.table.body[1];
    // [equipo, operador, inicial, final, horas, litros, adblue, observaciones]
    expect(dataRow[3]).toMatchObject({ text: 'En curso' });
    expect(dataRow[4]).toMatchObject({ text: '—' });
    expect(dataRow[6]).toMatchObject({ text: '—' });
  });

  describe('AdBlue', () => {
    function adBlueCell(card: ShiftReportCardInput) {
      const doc = buildShiftExitReportDocDefinition({
        shiftDate: '2026-09-28',
        shiftType: 'DIURNO',
        supervisorName: 'Ana Soto',
        generatedAt: new Date(),
        requestedAt: new Date(),
        cards: [card],
      });
      const table = (doc.content as Content[]).find(
        (c): c is Content & { table: Table } =>
          typeof c === 'object' && c !== null && 'table' in c,
      )!.table;
      return { header: table.body[0][6], cell: table.body[1][6], table };
    }

    it('la tabla tiene la columna AdBlue (L) y una fila por tarjeta del mismo ancho', () => {
      const { header, table } = adBlueCell(CARD);
      expect(header).toMatchObject({ text: 'AdBlue (L)' });
      expect(table.widths).toHaveLength(table.body[0].length);
      expect(table.body[1]).toHaveLength(table.body[0].length);
    });

    it('muestra los litros cuando hubo AdBlue', () => {
      expect(adBlueCell(CARD).cell).toMatchObject({ text: '12,5' });
    });

    it('muestra "—" cuando no hubo AdBlue', () => {
      expect(
        adBlueCell({ ...CARD, adBlue: false, adBlueLiters: null }).cell,
      ).toMatchObject({ text: '—' });
    });
  });

  it('la tabla muestra las horas máquina calculadas para una tarjeta cerrada', () => {
    const doc = buildShiftExitReportDocDefinition({
      shiftDate: '2026-09-28',
      shiftType: 'DIURNO',
      supervisorName: 'Ana Soto',
      generatedAt: new Date(),
      requestedAt: new Date(),
      cards: [CARD],
    });

    const content = doc.content as Content[];
    const tableContent = content.find(
      (c): c is Content & { table: Table } =>
        typeof c === 'object' && c !== null && 'table' in c,
    );
    const dataRow = tableContent!.table.body[1];
    expect(dataRow[3]).toMatchObject({ text: '108,5' });
    expect(dataRow[4]).toMatchObject({ text: '8,5' });
    expect(dataRow[5]).toMatchObject({ text: '40' });
  });

  it('el footer arma "N equipos" y el número de página', () => {
    const doc = buildShiftExitReportDocDefinition({
      shiftDate: '2026-09-28',
      shiftType: 'DIURNO',
      supervisorName: 'Ana Soto',
      generatedAt: new Date(),
      requestedAt: new Date(),
      cards: [CARD, CARD],
    });

    expect(typeof doc.footer).toBe('function');
    const footerFn = doc.footer as (
      currentPage: number,
      pageCount: number,
      pageSize: { width: number; height: number; orientation: 'portrait' },
    ) => Content;
    const footerContent = footerFn(1, 3, {
      width: 595,
      height: 842,
      orientation: 'portrait',
    }) as { columns: Content[] };
    expect(footerContent.columns[0]).toMatchObject({ text: '2 equipos' });
    expect(footerContent.columns[1]).toMatchObject({ text: 'Página 1 de 3' });
  });

  it('con 1 sola tarjeta, el footer dice "1 equipo" (singular)', () => {
    const doc = buildShiftExitReportDocDefinition({
      shiftDate: '2026-09-28',
      shiftType: 'DIURNO',
      supervisorName: 'Ana Soto',
      generatedAt: new Date(),
      requestedAt: new Date(),
      cards: [CARD],
    });

    const footerFn = doc.footer as (
      currentPage: number,
      pageCount: number,
      pageSize: { width: number; height: number; orientation: 'portrait' },
    ) => { columns: Content[] };
    const footerContent = footerFn(1, 1, {
      width: 595,
      height: 842,
      orientation: 'portrait',
    });
    expect(footerContent.columns[0]).toMatchObject({ text: '1 equipo' });
  });
});
