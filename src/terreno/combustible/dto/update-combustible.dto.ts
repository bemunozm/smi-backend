/**
 * `PATCH /api/combustible/:id` — sin campos propios (`fotoUrl` legacy no se
 * acepta, ver `CreateCombustibleDto`). Con `forbidNonWhitelisted` global,
 * cualquier body no vacío se rechaza con 400.
 */
export class UpdateCombustibleDto {}
