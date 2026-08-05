/**
 * Shape público de un usuario, expuesto por `UsersModule` al frontend.
 * Mapeado explícitamente desde el modelo Prisma `User` — nunca se devuelve
 * el registro crudo, así se evita filtrar campos sensibles/no acordados
 * (`banReason`, `banExpires`) aunque el modelo los tenga.
 *
 * `createdAt`/`updatedAt` se serializan a ISO string explícitamente (no se
 * deja el `Date` de Prisma "colar" confiando en el `JSON.stringify` por
 * defecto de Express) para que el tipo declarado (`string`) sea honesto.
 */
export interface UserResponseDto {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: string;
  banned: boolean | null;
  createdAt: string;
  updatedAt: string;
}
