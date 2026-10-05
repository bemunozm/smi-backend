import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  assertExpectedLocked,
  definedFields,
} from '../../common/concurrency/assert-expected-locked';
import type { ExpectedValues } from '../../common/concurrency/expected-fields';
import {
  createOrReturn,
  isPrimaryKeyViolation,
} from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { QueryCategoriesDto } from './dto/query-categories.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/**
 * El conteo viaja con la categoría porque la pantalla lo necesita para dos
 * cosas a la vez: mostrar cuánto pesa cada una y explicar por qué una no se
 * puede borrar. Pedirlo aparte obligaría a una segunda llamada por fila.
 */
const WITH_ITEM_COUNT = {
  _count: { select: { items: true } },
} satisfies Prisma.ItemCategoryInclude;

const CAMPO_LABEL: Record<string, string> = { name: 'Nombre' };

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(filters: QueryCategoriesDto) {
    const where: Prisma.ItemCategoryWhereInput = {};

    if (filters.q) where.name = { contains: filters.q, mode: 'insensitive' };

    // Con `type`, la lista se reduce a las categorías que sí tienen ítems de
    // esa clase — y el conteo pasa a contar solo esos, o diría "4 ítems" de una
    // categoría que en esta pestaña se ve vacía.
    if (filters.type) {
      where.items = { some: { type: filters.type, isActive: true } };
    }

    return this.prisma.itemCategory.findMany({
      where,
      include: filters.type
        ? {
            _count: {
              select: {
                items: { where: { type: filters.type, isActive: true } },
              },
            },
          }
        : WITH_ITEM_COUNT,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const category = await this.prisma.itemCategory.findUnique({
      where: { id },
      include: WITH_ITEM_COUNT,
    });
    if (!category) {
      throw new NotFoundException(`Categoría "${id}" no encontrada`);
    }
    return category;
  }

  async create(dto: CreateCategoryDto, userId: string) {
    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe una categoría con ese id de otro usuario',
      findExisting: async (id) => {
        const owner = await this.prisma.itemCategory.findUnique({
          where: { id },
          select: { createdById: true },
        });
        if (!owner) return null;
        return { ownerId: owner.createdById, result: () => this.findOne(id) };
      },
      create: async () => {
        await this.assertNombreLibre(dto.name);
        try {
          return await this.prisma.itemCategory.create({
            data: {
              ...(dto.id ? { id: dto.id } : {}),
              name: dto.name,
              createdById: userId,
            },
            include: WITH_ITEM_COUNT,
          });
        } catch (error: unknown) {
          // Un choque con la PK es la carrera de dos reintentos con el mismo
          // id: lo resuelve `createOrReturn`, no es un nombre repetido.
          if (isPrimaryKeyViolation(error)) throw error;
          throw this.mapUniqueConstraintError(error, dto.name);
        }
      },
    });
  }

  async update(id: string, dto: UpdateCategoryDto, expected?: ExpectedValues) {
    await this.findOne(id);
    if (dto.name) await this.assertNombreLibre(dto.name, id);

    const write = (db: Prisma.TransactionClient) =>
      db.itemCategory.update({
        where: { id },
        data: dto,
        include: WITH_ITEM_COUNT,
      });
    try {
      if (!expected) return await write(this.prisma);
      return await this.prisma.$transaction(async (tx) => {
        await assertExpectedLocked({
          tx,
          table: 'itemCategory',
          id,
          expected,
          read: (db) =>
            db.itemCategory.findUnique({
              where: { id },
              select: { name: true },
            }),
          desired: definedFields(dto),
          labels: CAMPO_LABEL,
          notFoundMessage: `Categoría "${id}" no encontrada`,
        });
        return write(tx);
      });
    } catch (error: unknown) {
      throw this.mapUniqueConstraintError(error, dto.name);
    }
  }

  /**
   * Se bloquea si tiene ítems. La FK es `SetNull`, así que un borrado físico
   * sí funcionaría — pero dejaría N ítems sin categoría sin decirlo, y eso solo
   * se descubre cuando alguien filtra y no encuentra lo que buscaba. Vaciarla
   * primero es una decisión del bodeguero, no un efecto secundario.
   */
  async remove(id: string): Promise<void> {
    const category = await this.findOne(id);

    if (category._count.items > 0) {
      throw new ConflictException(
        `La categoría "${category.name}" tiene ${category._count.items} ítem(s) asociados. ` +
          'Reasignalos a otra categoría antes de eliminarla.',
      );
    }

    await this.prisma.itemCategory.delete({ where: { id } });
  }

  /**
   * El índice único de Postgres distingue mayúsculas: sin esta comprobación
   * "Filtros" y "filtros" conviven como dos categorías, y el selector muestra
   * las dos sin que nadie entienda la diferencia.
   */
  private async assertNombreLibre(
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.prisma.itemCategory.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { name: true },
    });

    if (clash) {
      throw new ConflictException(
        `Ya existe una categoría llamada "${clash.name}"`,
      );
    }
  }

  private mapUniqueConstraintError(error: unknown, name?: string): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        `Ya existe una categoría llamada "${name ?? ''}"`,
      );
    }
    return error;
  }
}
