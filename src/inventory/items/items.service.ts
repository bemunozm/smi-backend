import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MovementReason, Prisma } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { StockService } from '../stock.service';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { CreateItemDto } from './dto/create-item.dto';
import { QueryItemsDto } from './dto/query-items.dto';
import { UpdateItemDto } from './dto/update-item.dto';

/**
 * Cada bodega donde el ítem tiene ficha de saldo. Se devuelve junto al ítem
 * para que la pantalla no tenga que pedir el desglose aparte.
 */
const STOCK_INCLUDE = {
  stocks: {
    select: {
      branchId: true,
      quantity: true,
      minimumQuantity: true,
      branch: { select: { id: true, name: true } },
    },
    orderBy: { branch: { name: 'asc' } },
  },
  category: { select: { id: true, name: true } },
} satisfies Prisma.InventoryItemInclude;

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  findAll(filters: QueryItemsDto) {
    return this.prisma.inventoryItem.findMany({
      where: this.buildWhere(filters),
      include: STOCK_INCLUDE,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const item = await this.prisma.inventoryItem.findUnique({
      where: { id },
      include: STOCK_INCLUDE,
    });
    if (!item) throw new NotFoundException(`Ítem "${id}" no encontrado`);
    return item;
  }

  /**
   * Kardex del ítem: su historial de asientos con el saldo resultante en cada
   * punto. Cada renglón lleva su bodega — sin eso, el saldo de un ítem
   * repartido en varias sucursales "salta" sin explicación.
   */
  async kardex(id: string, branchId?: string) {
    const item = await this.findOne(id);

    const movements = await this.prisma.stockMovement.findMany({
      where: { itemId: id, ...(branchId ? { branchId } : {}) },
      orderBy: { occurredAt: 'desc' },
      include: {
        branch: { select: { id: true, name: true } },
        sourceBranch: { select: { id: true, name: true } },
        destinationBranch: { select: { id: true, name: true } },
        equipment: { select: { id: true, internalCode: true } },
      },
    });

    return { item, movements };
  }

  async create(dto: CreateItemDto, performedById: string) {
    const { initialQuantity, branchId, ...card } = dto;

    try {
      // La existencia inicial entra como movimiento de COMPRA, no como columna
      // suelta: así el primer renglón del kardex explica de dónde salió el
      // saldo, en vez de aparecer una existencia sin origen.
      return await this.prisma.$transaction(async (tx) => {
        const item = await tx.inventoryItem.create({ data: card });

        if (initialQuantity && initialQuantity > 0 && branchId) {
          await this.stock.receive(
            {
              itemId: item.id,
              branchId,
              quantity: initialQuantity,
              reason: MovementReason.PURCHASE,
              performedById,
              notes: 'Existencia inicial al dar de alta el ítem',
            },
            tx,
          );
        }

        return tx.inventoryItem.findUniqueOrThrow({
          where: { id: item.id },
          include: STOCK_INCLUDE,
        });
      });
    } catch (error: unknown) {
      throw this.translateKnownErrors(error, dto);
    }
  }

  async update(id: string, dto: UpdateItemDto) {
    await this.findOne(id);
    try {
      return await this.prisma.inventoryItem.update({
        where: { id },
        data: dto,
        include: STOCK_INCLUDE,
      });
    } catch (error: unknown) {
      throw this.translateKnownErrors(error);
    }
  }

  /** Corrección tras conteo físico de una bodega. Delega en el service de saldos. */
  async adjust(id: string, dto: AdjustStockDto, performedById: string) {
    await this.findOne(id);

    const movement = await this.stock.adjustToCount({
      itemId: id,
      branchId: dto.branchId,
      countedQuantity: dto.countedQuantity,
      performedById,
      notes: dto.notes,
    });

    return { item: await this.findOne(id), movement };
  }

  /**
   * Un ítem con movimientos es historia del inventario: borrarlo se llevaría el
   * kardex por delante (`onDelete: Cascade`). Se bloquea explícitamente y se
   * sugiere la baja lógica, en vez de dejar que la FK decida.
   */
  async remove(id: string): Promise<void> {
    const item = await this.prisma.inventoryItem.findUnique({
      where: { id },
      include: { _count: { select: { movements: true } } },
    });

    if (!item) throw new NotFoundException(`Ítem "${id}" no encontrado`);

    if (item._count.movements > 0) {
      throw new ConflictException(
        `El ítem ${item.sku} tiene ${item._count.movements} movimiento(s) registrados y no se puede eliminar sin perder su kardex. ` +
          'Marcalo como inactivo (isActive=false) para retirarlo de los selectores conservando el historial.',
      );
    }

    await this.prisma.inventoryItem.delete({ where: { id } });
  }

  private buildWhere(filters: QueryItemsDto): Prisma.InventoryItemWhereInput {
    const where: Prisma.InventoryItemWhereInput = {};

    if (filters.q) {
      where.OR = [
        { sku: { contains: filters.q, mode: 'insensitive' } },
        { name: { contains: filters.q, mode: 'insensitive' } },
        { partNumber: { contains: filters.q, mode: 'insensitive' } },
      ];
    }

    if (filters.type) where.type = filters.type;
    if (filters.categoryId) where.categoryId = filters.categoryId;
    if (filters.isActive !== undefined) where.isActive = filters.isActive;

    return where;
  }

  private translateKnownErrors(error: unknown, dto?: CreateItemDto): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002' && dto) {
        return new ConflictException(
          `Ya existe un ítem con el SKU "${dto.sku}"`,
        );
      }
      // La única FK del ítem es `categoryId`, así que el mensaje puede ser
      // específico sin inspeccionar el meta del error.
      if (error.code === 'P2003') {
        return new ConflictException('La categoría indicada no existe');
      }
    }
    return error;
  }
}
