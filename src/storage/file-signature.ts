/**
 * Detección de tipo de archivo por bytes reales (magic numbers) — nunca por
 * el nombre/extensión que mandó el cliente ni por el `Content-Type` del
 * request, ambos falsificables (ver Diseño del RFC, "Validación por bytes
 * reales"). Cualquier formato no reconocido acá (SVG, HTML, HEIC, GIF, etc.)
 * devuelve `null` y el llamador debe rechazar el archivo.
 */

export type SupportedExtension = 'jpg' | 'png' | 'webp' | 'pdf';

export interface FileSignatureMatch {
  readonly ext: SupportedExtension;
  readonly contentType: string;
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');

function startsWith(buffer: Buffer, magic: readonly number[]): boolean {
  if (buffer.length < magic.length) {
    return false;
  }
  return magic.every((byte, index) => buffer[index] === byte);
}

function isWebp(buffer: Buffer): boolean {
  if (buffer.length < 12) {
    return false;
  }
  return (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

/** Devuelve `null` si los bytes no matchean ninguna firma soportada. */
export function detectFileSignature(buffer: Buffer): FileSignatureMatch | null {
  if (startsWith(buffer, JPEG_MAGIC)) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (startsWith(buffer, PNG_MAGIC)) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (isWebp(buffer)) {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  if (
    buffer.length >= PDF_MAGIC.length &&
    buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)
  ) {
    return { ext: 'pdf', contentType: 'application/pdf' };
  }
  return null;
}
