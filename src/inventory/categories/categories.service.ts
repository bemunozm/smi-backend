import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

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

  async create(dto: CreateCategoryDto) {
    await this.assertNombreLibre(dto.name);
    try {
      return await this.prisma.itemCategory.create({
        data: { name: dto.name },
        include: WITH_ITEM_COUNT,
      });
    } catch (error: unknown) {
      throw this.mapUniqueConstraintError(error, dto.name);
    }
  }

  async update(id: string, dto: UpdateCategoryDto) {
    await this.findOne(id);
    if (dto.name) await this.assertNombreLibre(dto.name, id);

    try {
      return await this.prisma.itemCategory.update({
        where: { id },
        data: dto,
        include: WITH_ITEM_COUNT,
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
