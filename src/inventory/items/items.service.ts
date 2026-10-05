import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MovementReason, Prisma } from '@prisma/client';

import {
  assertExpectedLocked,
  definedFields,
} from '../../common/concurrency/assert-expected-locked';
import type { ExpectedFields } from '../../common/concurrency/expected-fields';
import { ERROR_CODES } from '../../common/errors/error-codes';
import {
  createOrReturn,
  isPrimaryKeyViolation,
} from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StockService, type PendingStockEvents } from '../stock.service';
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

/** `createdById` es interno: no sale en ninguna respuesta. */
const ITEM_OMIT = { createdById: true } satisfies Prisma.InventoryItemOmit;

/** Cómo se nombra cada dato en el mensaje de conflicto (`STALE_UPDATE`). */
const CAMPO_LABEL: Record<string, string> = {
  name: 'Nombre',
  description: 'Descripción',
  unit: 'Unidad',
  type: 'Tipo',
  categoryId: 'Categoría',
  partNumber: 'N.° de parte',
  defaultSupplier: 'Proveedor',
  isCritical: 'Crítico',
  isActive: 'Activo',
};

const UPDATE_FIELDS = {
  name: true,
  description: true,
  unit: true,
  type: true,
  categoryId: true,
  partNumber: true,
  defaultSupplier: true,
  isCritical: true,
  isActive: true,
} satisfies Prisma.InventoryItemSelect;

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
      omit: ITEM_OMIT,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const item = await this.prisma.inventoryItem.findUnique({
      where: { id },
      include: STOCK_INCLUDE,
      omit: ITEM_OMIT,
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
    return createOrReturn({
      id: dto.id,
      userId: performedById,
      conflictMessage: 'Ya existe un ítem con ese id de otro usuario',
      // El reintento propio devuelve el ítem tal como está hoy y NO vuelve a
      // recibir la existencia inicial.
      findExisting: async (id) => {
        const owner = await this.prisma.inventoryItem.findUnique({
          where: { id },
          select: { createdById: true },
        });
        if (!owner) return null;
        return { ownerId: owner.createdById, result: () => this.findOne(id) };
      },
      create: () => this.createFresh(dto, performedById),
    });
  }

  private async createFresh(dto: CreateItemDto, performedById: string) {
    const { id, initialQuantity, branchId, ...card } = dto;
    const events: PendingStockEvents = [];

    try {
      // La existencia inicial entra como movimiento de COMPRA, no como columna
      // suelta: así el primer renglón del kardex explica de dónde salió el
      // saldo, en vez de aparecer una existencia sin origen.
      const item = await this.prisma.$transaction(async (tx) => {
        const created = await tx.inventoryItem.create({
          data: {
            ...(id ? { id } : {}),
            ...card,
            createdById: performedById,
          },
        });

        if (initialQuantity && initialQuantity > 0 && branchId) {
          await this.stock.receive(
            {
              itemId: created.id,
              branchId,
              quantity: initialQuantity,
              reason: MovementReason.PURCHASE,
              performedById,
              notes: 'Existencia inicial al dar de alta el ítem',
            },
            { tx, events },
          );
        }

        return tx.inventoryItem.findUniqueOrThrow({
          where: { id: created.id },
          include: STOCK_INCLUDE,
          omit: ITEM_OMIT,
        });
      });
      this.stock.emitPending(events);
      return item;
    } catch (error: unknown) {
      // Un choque con la PK es la carrera de dos reintentos con el mismo id:
      // lo resuelve `createOrReturn`, no es un SKU repetido.
      if (isPrimaryKeyViolation(error)) throw error;
      throw this.translateKnownErrors(error, dto);
    }
  }

  async update(id: string, dto: UpdateItemDto, expected?: ExpectedFields) {
    await this.findOne(id);
    const write = (db: Prisma.TransactionClient) =>
      db.inventoryItem.update({
        where: { id },
        data: dto,
        include: STOCK_INCLUDE,
        omit: ITEM_OMIT,
      });
    try {
      if (!expected) return await write(this.prisma);
      return await this.prisma.$transaction(async (tx) => {
        await assertExpectedLocked({
          tx,
          table: 'inventoryItem',
          id,
          expected,
          read: (db) =>
            db.inventoryItem.findUnique({
              where: { id },
              select: UPDATE_FIELDS,
            }),
          desired: definedFields(dto),
          labels: CAMPO_LABEL,
          notFoundMessage: `Ítem "${id}" no encontrado`,
        });
        return write(tx);
      });
    } catch (error: unknown) {
      throw this.translateKnownErrors(error);
    }
  }

  /**
   * Corrección tras conteo físico de una bodega. Delega en el service de
   * saldos. Con `id` del cliente es reintentable: el mismo conteo enviado dos
   * veces deja UN solo asiento.
   */
  async adjust(id: string, dto: AdjustStockDto, performedById: string) {
    return createOrReturn({
      id: dto.id,
      userId: performedById,
      conflictMessage: 'Ya existe un movimiento con ese id de otro usuario',
      findExisting: async (movementId) => {
        const movement = await this.prisma.stockMovement.findUnique({
          where: { id: movementId },
        });
        if (!movement) return null;
        if (
          movement.itemId !== id ||
          movement.reason !== MovementReason.PHYSICAL_ADJUSTMENT
        ) {
          throw new ConflictException({
            message: 'Ya existe un movimiento con ese id que no es este conteo',
            code: ERROR_CODES.ID_CONFLICT,
          });
        }
        return {
          ownerId: movement.performedById,
          result: async () => ({ item: await this.findOne(id), movement }),
        };
      },
      create: async () => {
        await this.findOne(id);

        const movement = await this.stock.adjustToCount({
          id: dto.id,
          itemId: id,
          branchId: dto.branchId,
          countedQuantity: dto.countedQuantity,
          expectedQuantity: dto.expectedQuantity,
          performedById,
          notes: dto.notes,
        });

        return { item: await this.findOne(id), movement };
      },
    });
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
