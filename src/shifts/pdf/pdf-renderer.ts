/**
 * Envoltorio de renderizado sobre el singleton de `pdfmake` (versión 0.3.x
 * instalada — ver `node_modules/pdfmake/js/index.js`: `module.exports = new
 * pdfmake()`, NO la clase `PdfPrinter` de 0.1.x/0.2.x). Separado de
 * `shift-report.pdf.ts` (el `docDefinition` es una función PURA, testeable
 * sin esto) — acá vive todo lo que SÍ toca pdfmake/IO: fuentes, políticas de
 * acceso y el `getBuffer()` final.
 *
 * Fuentes: solo las 4 variantes estándar de Helvetica, por NOMBRE (pdfkit las
 * trae embebidas — no son archivos en disco, así que no se envía ningún
 * archivo de fuente con el repo).
 *
 * Políticas de acceso (0.3.x introduce `setUrlAccessPolicy`/
 * `setLocalAccessPolicy` — ver docstring de `PDFDocument.validateLocalFile`
 * en el propio paquete): se deniegan TODAS las URLs remotas (no usamos
 * imágenes/adjuntos por URL) y todo acceso a archivo local EXCEPTO los 4
 * nombres de fuente estándar de arriba — sin este permiso puntual,
 * `provideFont` llama a `validateLocalFile('Helvetica')` y la política
 * "deny-all" ingenua lo rechazaría también a él (pdfkit resuelve esos
 * nombres con datos embebidos, nunca lee un archivo real, pero pdfmake valida
 * el string ANTES de saber eso).
 */
import pdfMake from 'pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

const STANDARD_HELVETICA_FONT = {
  normal: 'Helvetica',
  bold: 'Helvetica-Bold',
  italics: 'Helvetica-Oblique',
  bolditalics: 'Helvetica-BoldOblique',
} as const;

const ALLOWED_LOCAL_FONT_NAMES = new Set<string>(
  Object.values(STANDARD_HELVETICA_FONT),
);

let configured = false;

/** Idempotente — el singleton de pdfmake vive a nivel de proceso, así que
 * configurarlo más de una vez es un no-op seguro (evita reconfigurar en cada
 * request). */
function ensureConfigured(): void {
  if (configured) return;

  pdfMake.setFonts({ Helvetica: STANDARD_HELVETICA_FONT });
  // Nunca se descarga nada por red al armar este PDF (sin logo, sin imágenes
  // por URL) — deny-all explícito en vez de dejarlo "sin configurar" (0.3.x
  // solo emite un warning si no se llama, no bloquea nada por defecto).
  pdfMake.setUrlAccessPolicy(() => false);
  // Deny-all salvo los 4 nombres de fuente estándar (ver docstring de
  // cabecera) — nunca abre un archivo arbitrario del disco del servidor.
  pdfMake.setLocalAccessPolicy((path) => ALLOWED_LOCAL_FONT_NAMES.has(path));

  configured = true;
}

/** Renderiza un `docDefinition` (ver `shift-report.pdf.ts`) a los bytes
 * finales del PDF. */
export async function renderPdfBuffer(
  docDefinition: TDocumentDefinitions,
): Promise<Buffer> {
  ensureConfigured();
  const doc = pdfMake.createPdf(docDefinition);
  return doc.getBuffer();
}
