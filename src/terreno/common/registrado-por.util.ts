import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * `createdById` (hallazgos, trabajos extra) es una soft ref a `user.id` — sin
 * relación Prisma, igual que `asignadoAId` en Mantenimiento. Para exponer
 * "quién lo registró" sin pagar un lookup por fila, se resuelven todos los ids
 * distintos en UN solo `findMany` y se devuelve `userId -> nombre`. Un id sin
 * usuario (cuenta borrada) simplemente no está en el mapa → `registradoPor`
 * queda null.
 */
export async function resolveNombresUsuarios(
  prisma: PrismaService,
  userIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name]));
}
