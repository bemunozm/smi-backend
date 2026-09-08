/**
 * Escapa los 5 caracteres relevantes de HTML. Úsalo sobre CUALQUIER valor
 * dinámico (título, cuerpo, nombre de usuario, etc.) antes de interpolarlo
 * en el `html` que recibe `MailService.sendMail` — esos valores vienen de
 * datos de dominio (p. ej. la descripción de un Hallazgo) y nunca deben
 * tratarse como HTML de confianza.
 */
const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}
