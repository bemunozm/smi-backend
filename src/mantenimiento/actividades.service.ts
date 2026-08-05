import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { resolveAsignadosMap } from './common/asignado.util';
import type { ActividadResponseDto } from './dto/actividad-response.dto';
import type { AsignadoResponseDto } from './dto/asignado-response.dto';
import type { CreateActividadDto } from './dto/create-actividad.dto';
import type { UpdateActividadDto } from './dto/update-actividad.dto';

const ACTIVIDAD_SELECT = {
  id: true,
  descripcion: true,
  origen: true,
  referencia: true,
  asignadoAId: true,
  equipoId: true,
  hallazgoId: true,
  estado: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ActividadSelect;

type SelectedActividad = Prisma.ActividadGetPayload<{
  select: typeof ACTIVIDAD_SELECT;
}>;

@Injectable()
export class ActividadesService {
  private readonly logger = new Logger(ActividadesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<ActividadResponseDto[]> {
    const actividades = await this.prisma.actividad.findMany({
      select: ACTIVIDAD_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    const asignados = await resolveAsignadosMap(
      this.prisma,
      actividades.map((actividad) => actividad.asignadoAId),
    );

    return actividades.map((actividad) =>
      this.toResponseDto(actividad, asignados),
    );
  }

  async create(dto: CreateActividadDto): Promise<ActividadResponseDto> {
    const actividad = await this.prisma.actividad.create({
      data: {
        descripcion: dto.descripcion,
        origen: dto.origen,
        referencia: dto.referencia,
        asignadoAId: dto.asignadoAId,
        equipoId: dto.equipoId,
        hallazgoId: dto.hallazgoId,
      },
      select: ACTIVIDAD_SELECT,
    });

    this.logger.log(`Actividad creada: ${actividad.id}`);

    const asignados = await resolveAsignadosMap(this.prisma, [
      actividad.asignadoAId,
    ]);
    return this.toResponseDto(actividad, asignados);
  }

  async update(
    id: string,
    dto: UpdateActividadDto,
  ): Promise<ActividadResponseDto> {
    await this.findActividadOrThrow(id);

    const actividad = await this.prisma.actividad.update({
      where: { id },
      data: { estado: dto.estado },
      select: ACTIVIDAD_SELECT,
    });

    this.logger.log(`Actividad actualizada: ${id} -> estado=${dto.estado}`);

    const asignados = await resolveAsignadosMap(this.prisma, [
      actividad.asignadoAId,
    ]);
    return this.toResponseDto(actividad, asignados);
  }

  private async findActividadOrThrow(id: string): Promise<SelectedActividad> {
    const actividad = await this.prisma.actividad.findUnique({
      where: { id },
      select: ACTIVIDAD_SELECT,
    });

    if (!actividad) {
      throw new NotFoundException(`Actividad con id "${id}" no encontrada`);
    }

    return actividad;
  }

  private toResponseDto(
    actividad: SelectedActividad,
    asignados: Map<string, AsignadoResponseDto>,
  ): ActividadResponseDto {
    return {
      id: actividad.id,
      descripcion: actividad.descripcion,
      origen: actividad.origen,
      referencia: actividad.referencia,
      asignadoA: actividad.asignadoAId
        ? (asignados.get(actividad.asignadoAId) ?? null)
        : null,
      equipoId: actividad.equipoId,
      hallazgoId: actividad.hallazgoId,
      estado: actividad.estado,
      createdAt: actividad.createdAt.toISOString(),
      updatedAt: actividad.updatedAt.toISOString(),
    };
  }
}
