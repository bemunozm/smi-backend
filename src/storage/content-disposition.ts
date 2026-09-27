/**
 * Header `Content-Disposition: inline` para servir documentos con el nombre
 * "humano" (el que subió el usuario), sin exponer la key interna del bucket.
 * Sigue el patrón estándar de doble valor: `filename` (fallback ASCII, para
 * clientes viejos) + `filename*` (RFC 5987, UTF-8, para el resto).
 */

const UNSAFE_HEADER_CHARS = /["\\\r\n;]/g;
const NON_ASCII_OR_CONTROL = /[^\x20-\x7E]/g;
const FALLBACK_BASE_NAME = 'archivo';

/** Extensión real de la key (después del último punto del último segmento). */
function extensionFromKey(key: string): string {
  const lastSlash = key.lastIndexOf('/');
  const lastDot = key.lastIndexOf('.');
  if (lastDot === -1 || lastDot <= lastSlash) {
    return '';
  }
  return key.slice(lastDot + 1);
}

function stripExtension(name: string): string {
  const lastDot = name.lastIndexOf('.');
  return lastDot > 0 ? name.slice(0, lastDot) : name;
}

/** Quita quotes, backslash, CR/LF y `;` — los caracteres que romperían el header. */
function sanitize(name: string): string {
  return name.replace(UNSAFE_HEADER_CHARS, '').trim();
}

function toAsciiFallback(name: string): string {
  const ascii = name.replace(NON_ASCII_OR_CONTROL, '_');
  return ascii.length > 0 ? ascii : FALLBACK_BASE_NAME;
}

/** `ext-value` de RFC 5987 (usado por `filename*=UTF-8''...`). */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value)
    .replace(
      /['()]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replace(/\*/g, '%2A');
}

/**
 * La extensión final SIEMPRE sale de `key` (los bytes reales validados al
 * subir), nunca del `fileName` que llega en el request — evita un nombre
 * desalineado con el contenido real del objeto.
 */
export function buildContentDisposition(
  rawFileName: string,
  key: string,
): string {
  const ext = extensionFromKey(key);
  const sanitizedBase = stripExtension(sanitize(rawFileName));
  const baseName =
    sanitizedBase.length > 0 ? sanitizedBase : FALLBACK_BASE_NAME;
  const finalName = ext.length > 0 ? `${baseName}.${ext}` : baseName;

  const asciiFallback = toAsciiFallback(finalName);
  const encoded = encodeRfc5987(finalName);

  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
