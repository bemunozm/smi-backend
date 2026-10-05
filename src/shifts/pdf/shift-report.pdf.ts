/**
 * `docDefinition` del PDF de reporte de salida de turno — función PURA a propósito (sin tocar pdfmake ni el
 * storage): así es testeable sin renderizar un PDF real. `pdf-renderer.ts`
 * es quien la alimenta a pdfmake y devuelve el `Buffer` final.
 */
import type { Content, Table, TDocumentDefinitions } from 'pdfmake/interfaces';

import { BUSINESS_TIME_ZONE } from '../../common/dates/business-time';

/** Encabezado de texto del PDF — la razón social del cliente hasta que llegue
 * su logo. Si un segundo cliente aparece, esto se mueve a config (por ahora
 * un único cliente, no vale la pena la indirección). */
export const SHIFT_REPORT_MASTHEAD = 'TRANSPORTES OPTIMIZA SPA';
const REPORT_TITLE = 'Reporte de salida de turno';

export interface ShiftReportCardInput {
  readonly equipoInternalCode: string;
  readonly equipoType: string;
  readonly operatorName: string;
  readonly valorInicial: number;
  readonly valorFinal: number | null;
  /** `valorFinal − valorInicial`, `null` si la tarjeta sigue abierta. */
  readonly horasMaquina: number | null;
  readonly fuelLiters: number | null;
  readonly adBlue: boolean;
  /** Solo tiene valor cuando `adBlue` es `true`. */
  readonly adBlueLiters: number | null;
  readonly observaciones: string | null;
}

export interface ShiftReportDocInput {
  /** `YYYY-MM-DD` — ver `src/shifts/date-only.ts`. NUNCA se parsea con
   * `new Date(...)` acá (medianoche UTC se corre de día en Santiago): se
   * formatea directo desde las partes del string, ver `formatShiftDateEs`. */
  readonly shiftDate: string;
  readonly shiftType: string;
  readonly supervisorName: string;
  /** Hora del SERVIDOR al generar el PDF. */
  readonly generatedAt: Date;
  /** Hora del DISPOSITIVO al pedir el reporte (`requestedAt` del DTO). */
  readonly requestedAt: Date;
  readonly cards: readonly ShiftReportCardInput[];
}

/** `'2026-09-28'` → `'28-09-2026'`. Regex ya validada por el DTO
 * (`DATE_ONLY_REGEX`) antes de llegar acá — de todas formas se valida de
 * nuevo por si este builder se llama con datos que no pasaron por el DTO
 * (ej. un test). */
export function formatShiftDateEs(shiftDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(shiftDate);
  if (!match) {
    throw new Error(`shiftDate con formato inválido: "${shiftDate}"`);
  }
  const [, year, month, day] = match;
  return `${day}-${month}-${year}`;
}

export function formatShiftTypeEs(shiftType: string): string {
  return shiftType === 'DIURNO' ? 'Diurno' : 'Nocturno';
}

/** `es-CL` / `America/Santiago`, `DD-MM-YYYY, HH:mm` (formato nativo de
 * `Intl.DateTimeFormat` para este locale+zona). Usado SOLO para instantes
 * reales (`generatedAt`/`requestedAt`) — nunca para `shiftDate`, que es
 * date-only (ver `formatShiftDateEs`). */
export function formatSantiagoDateTime(date: Date): string {
  return new Intl.DateTimeFormat('es-CL', {
    timeZone: BUSINESS_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatNumber(value: number): string {
  return value.toLocaleString('es-CL', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function buildCardRow(card: ShiftReportCardInput): Table['body'][number] {
  return [
    { text: `${card.equipoInternalCode}\n${card.equipoType}`, fontSize: 9 },
    { text: card.operatorName, fontSize: 9 },
    { text: formatNumber(card.valorInicial), fontSize: 9, alignment: 'right' },
    {
      text:
        card.valorFinal !== null ? formatNumber(card.valorFinal) : 'En curso',
      fontSize: 9,
      alignment: 'right',
    },
    {
      text: card.horasMaquina !== null ? formatNumber(card.horasMaquina) : '—',
      fontSize: 9,
      alignment: 'right',
    },
    {
      text: card.fuelLiters !== null ? formatNumber(card.fuelLiters) : '—',
      fontSize: 9,
      alignment: 'right',
    },
    {
      text:
        card.adBlue && card.adBlueLiters !== null
          ? formatNumber(card.adBlueLiters)
          : '—',
      fontSize: 9,
      alignment: 'right',
    },
    { text: card.observaciones ?? '—', fontSize: 9 },
  ];
}

function buildCardsTable(cards: readonly ShiftReportCardInput[]): Content {
  const header: Table['body'][number] = [
    { text: 'Equipo', style: 'tableHeader' },
    { text: 'Operador', style: 'tableHeader' },
    { text: 'Horómetro inicial', style: 'tableHeader', alignment: 'right' },
    { text: 'Horómetro final', style: 'tableHeader', alignment: 'right' },
    { text: 'Horas máquina', style: 'tableHeader', alignment: 'right' },
    { text: 'Litros', style: 'tableHeader', alignment: 'right' },
    { text: 'AdBlue (L)', style: 'tableHeader', alignment: 'right' },
    { text: 'Observaciones', style: 'tableHeader' },
  ];

  return {
    table: {
      headerRows: 1,
      widths: ['15%', '13%', '11%', '11%', '11%', '9%', '10%', '20%'],
      body: [header, ...cards.map(buildCardRow)],
    },
    layout: 'lightHorizontalLines',
  };
}

/**
 * Construye el `docDefinition` completo. Función pura: mismo input, mismo
 * output — no toca pdfmake, storage ni el reloj (`generatedAt`/`requestedAt`
 * vienen del caller). `defaultStyle.font: 'Helvetica'` es OBLIGATORIO acá
 * (no alcanza con configurarlo en `pdf-renderer.ts`): el default de pdfmake
 * es `'Roboto'`, que no está en el diccionario de fuentes que arma el
 * renderer (solo Helvetica, sin archivos) — sin esto, `provideFont` lanza.
 */
export function buildShiftExitReportDocDefinition(
  input: ShiftReportDocInput,
): TDocumentDefinitions {
  const cardCount = input.cards.length;
  const equipoLabel = cardCount === 1 ? '1 equipo' : `${cardCount} equipos`;

  return {
    pageSize: 'A4',
    pageMargins: [40, 60, 40, 60],
    defaultStyle: { font: 'Helvetica', fontSize: 10 },
    styles: {
      masthead: { fontSize: 10, bold: true, color: '#555555' },
      title: { fontSize: 16, bold: true, margin: [0, 4, 0, 12] },
      label: { fontSize: 9, color: '#555555' },
      value: { fontSize: 10, bold: true },
      tableHeader: { fontSize: 9, bold: true, fillColor: '#eeeeee' },
    },
    content: [
      { text: SHIFT_REPORT_MASTHEAD, style: 'masthead' },
      { text: REPORT_TITLE, style: 'title' },
      {
        columns: [
          [
            { text: 'Turno', style: 'label' },
            {
              text: `${formatShiftDateEs(input.shiftDate)} — ${formatShiftTypeEs(input.shiftType)}`,
              style: 'value',
            },
          ],
          [
            { text: 'Supervisor', style: 'label' },
            { text: input.supervisorName, style: 'value' },
          ],
        ],
        margin: [0, 0, 0, 10],
      },
      {
        columns: [
          [
            { text: 'Generado el', style: 'label' },
            { text: formatSantiagoDateTime(input.generatedAt), style: 'value' },
          ],
          [
            { text: 'Solicitado el', style: 'label' },
            { text: formatSantiagoDateTime(input.requestedAt), style: 'value' },
          ],
        ],
        margin: [0, 0, 0, 16],
      },
      buildCardsTable(input.cards),
    ],
    footer: (currentPage: number, pageCount: number) => ({
      margin: [40, 0, 40, 0],
      columns: [
        { text: equipoLabel, fontSize: 8, color: '#777777' },
        {
          text: `Página ${currentPage} de ${pageCount}`,
          fontSize: 8,
          color: '#777777',
          alignment: 'right',
        },
      ],
    }),
  };
}
