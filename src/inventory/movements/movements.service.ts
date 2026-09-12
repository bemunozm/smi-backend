import { Injectable } from '@nestjs/common';
import { MovementDirection, Prisma, StockMovement } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { StockService } from '../stock.service';
import { CreateMovementDto } from './dto/create-movement.dto';
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

    return dto.direction === MovementDirection.IN
      ? this.stock.receive(input)
      : this.stock.issue(input);
  }
}
