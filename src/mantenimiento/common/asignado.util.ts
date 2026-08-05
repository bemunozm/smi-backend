import type { PrismaService } from '../../common/prisma/prisma.service';
import type { AsignadoResponseDto } from '../dto/asignado-response.dto';

/**
 * `asignadoAId` es una soft ref a `user.id` (sin relación Prisma — ver
 * comentario en `schema.prisma`). Para no pagar un lookup por fila en listas,
 * se resuelven todos los ids distintos en un solo `findMany` y se devuelve un
 * mapa `userId -> { id, nombre }` que el caller usa para armar `asignadoA`.
 */
export async function resolveAsignadosMap(
  prisma: PrismaService,
  asignadoAIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, AsignadoResponseDto>> {
  const ids = Array.from(
    new Set(asignadoAIds.filter((id): id is string => Boolean(id))),
  );

  if (ids.length === 0) {
    return new Map();
  }

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });

  return new Map(
    users.map((user) => [user.id, { id: user.id, nombre: user.name }]),
  );
}
