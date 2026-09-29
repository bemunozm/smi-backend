/**
 * `PATCH /api/combustible/:id` — sin campos propios: el único que tenía
 * (`fotoUrl` legacy) se retiró en el cierre de R2 (RFC Supervisión en
 * Terreno — ver `CreateCombustibleDto`). El endpoint queda vivo
 * (nadie pidió borrarlo) pero, con `forbidNonWhitelisted` global, cualquier
 * body no vacío se rechaza con 400 — el frontend nunca llamó a este
 * endpoint de todas formas (confirmado por grep).
 */
export class UpdateCombustibleDto {}
