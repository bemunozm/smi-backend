import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { createOrReturn } from '../common/idempotency/create-or-return';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreateUmbralDto } from './dto/create-umbral.dto';
import type { UmbralResponseDto } from './dto/umbral-response.dto';

const UMBRAL_SELECT = {
  id: true,
  tipoEquipo: true,
  tipoMantencion: true,
  umbralHoras: true,
} satisfies Prisma.UmbralMantenimientoSelect;

@Injectable()
export class UmbralesService {
  private readonly logger = new Logger(UmbralesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<UmbralResponseDto[]> {
    return this.prisma.umbralMantenimiento.findMany({
      select: UMBRAL_SELECT,
      orderBy: { tipoEquipo: 'asc' },
    });
  }

  async create(
    dto: CreateUmbralDto,
    userId: string,
  ): Promise<UmbralResponseDto> {
    return createOrReturn({
      id: dto.id,
      userId,
      conflictMessage: 'Ya existe un umbral con ese id de otro usuario',
      findExisting: async (id) => {
        const existing = await this.prisma.umbralMantenimiento.findUnique({
          where: { id },
          select: { ...UMBRAL_SELECT, createdById: true },
        });
        if (!existing) return null;
        const { createdById, ...umbral } = existing;
        return { ownerId: createdById, result: umbral };
      },
      create: () => this.createFresh(dto, userId),
    });
  }

  private async createFresh(
    dto: CreateUmbralDto,
    userId: string,
  ): Promise<UmbralResponseDto> {
    const umbral = await this.prisma.umbralMantenimiento.create({
      data: {
        ...(dto.id ? { id: dto.id } : {}),
        createdById: userId,
        tipoEquipo: dto.tipoEquipo,
        tipoMantencion: dto.tipoMantencion,
        umbralHoras: dto.umbralHoras,
      },
      select: UMBRAL_SELECT,
    });

    this.logger.log(`Umbral de mantenimiento creado: ${umbral.id}`);

    return umbral;
  }
}
