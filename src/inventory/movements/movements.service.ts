import { ConflictException, Injectable } from '@nestjs/common';
import { MovementDirection, Prisma, StockMovement } from '@prisma/client';

import { ERROR_CODES } from '../../common/errors/error-codes';
import { createOrReturn } from '../../common/idempotency/create-or-return';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StockService } from '../stock.service';
import { CreateMovementDto } from './dto/create-movement.dto';
import { isManualMovementReason } from './movement-reasons';
import { QueryMovementsDto } from './dto/query-movements.dto';

const DEFAULT_LIMIT = 100;

@Injectable()
export class MovementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  findAll(filters: QueryMovementsDto) {
    const where: Prisma.StockMovementWhereInput = {};

    if (filters.itemId) where.itemId = filters.itemId;
    if (filters.branchId) where.branchId = filters.branchId;
    if (filters.equipmentId) where.equipmentId = filters.equipmentId;
    if (filters.direction) where.direction = filters.direction;
    if (filters.reason) where.reason = filters.reason;

    if (filters.from || filters.to) {
      where.occurredAt = {
        ...(filters.from ? { gte: new Date(filters.from) } : {}),
        ...(filters.to ? { lte: new Date(filters.to) } : {}),
      };
    }

    return this.prisma.stockMovement.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: filters.limit ?? DEFAULT_LIMIT,
      include: {
        item: { select: { id: true, sku: true, name: true, unit: true } },
        branch: { select: { id: true, name: true } },
        sourceBranch: { select: { id: true, name: true } },
        destinationBranch: { select: { id: true, name: true } },
        equipment: { select: { id: true, internalCode: true } },
      },
    });
  }

  /**
   * Movimiento manual. Enruta al método correspondiente de `StockService` según
   * la dirección — la lógica de existencias vive allá, acá solo se decide el
   * signo.
   */
  create(
    dto: CreateMovementDto,
    performedById: string,
  ): Promise<StockMovement> {
    const input = {
      id: dto.id,
      itemId: dto.itemId,
      branchId: dto.branchId,
      quantity: dto.quantity,
      reason: dto.reason,
      performedById,
      equipmentId: dto.equipmentId ?? null,
      reference: dto.reference ?? null,
      documentNumber: dto.documentNumber ?? null,
      notes: dto.notes ?? null,
    };

    // Con `id` del cliente, el reintento propio devuelve el asiento ya
    // registrado (con su `resultingBalance` de entonces) sin mover saldo.
    return createOrReturn({
      id: dto.id,
      userId: performedById,
      conflictMessage: 'Ya existe un movimiento con ese id de otro usuario',
      findExisting: async (id) => {
        const movement = await this.prisma.stockMovement.findUnique({
          where: { id },
        });
        if (!movement) return null;
        // Un id que pertenece a un traspaso, un ajuste o un movimiento de otro
        // ítem o sentido no es un reintento de ESTE movimiento.
        if (
          !isManualMovementReason(movement.reason) ||
          movement.direction !== dto.direction ||
          movement.itemId !== dto.itemId
        ) {
          throw new ConflictException({
            message:
              'Ya existe un movimiento con ese id que no es este movimiento manual',
            code: ERROR_CODES.ID_CONFLICT,
          });
        }
        return { ownerId: movement.performedById, result: movement };
      },
      create: () =>
        dto.direction === MovementDirection.IN
          ? this.stock.receive(input)
          : this.stock.issue(input),
    });
  }
}
