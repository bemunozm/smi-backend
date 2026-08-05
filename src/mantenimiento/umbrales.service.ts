import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

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

  async create(dto: CreateUmbralDto): Promise<UmbralResponseDto> {
    const umbral = await this.prisma.umbralMantenimiento.create({
      data: {
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
