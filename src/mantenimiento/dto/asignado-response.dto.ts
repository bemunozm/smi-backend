/**
 * Shape público del usuario asignado, resuelto por lookup manual contra la
 * tabla `user` de Better Auth (sin relación Prisma — ver comentario en
 * `schema.prisma` sobre soft refs de este dominio).
 */
export interface AsignadoResponseDto {
  id: string;
  nombre: string;
}
