import { Injectable, NotFoundException } from '@nestjs/common';
import { ControlUnit } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { UpdateHorometroDto } from './dto/update-horometro.dto';

@Injectable()
export class HorometroService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateHorometroDto) {
    const equipo = await this.prisma.equipment.findUnique({
      where: { id: dto.equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    const registro = await this.prisma.registroHorometro.create({
      data: {
        equipoId: dto.equipoId,
        operador: dto.operador,
        turno: dto.turno,
        valorInicial: dto.valorInicial,
        valorFinal: dto.valorFinal ?? null,
        nivelCombustible: dto.nivelCombustible ?? null,
      },
    });

    // El write del valor actual solo aplica si la unidad se controla por
    // horómetro (RFC T01 §2, MEJORA-3) — si controla por kilometraje, este
    // registro de terreno no debe pisar `currentHourmeter`.
    if (dto.valorFinal != null && equipo.controlUnit === ControlUnit.HOURS) {
      await this.prisma.equipment.update({
        where: { id: dto.equipoId },
        data: { currentHourmeter: dto.valorFinal },
      });
      // TODO(motor-preventivo): disparar el umbral de Mantenimiento (Joaquín, guía §5).
    }

    return registro;
  }

  findAll() {
    return this.prisma.registroHorometro.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { internalCode: true } } },
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.registroHorometro.findUnique({
      where: { id },
    });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }

  async update(id: string, dto: UpdateHorometroDto) {
    const reg = await this.prisma.registroHorometro.update({
      where: { id },
      data: dto,
    });
    if (dto.valorFinal != null) {
      const equipo = await this.prisma.equipment.findUnique({
        where: { id: reg.equipoId },
        select: { controlUnit: true },
      });
      if (equipo?.controlUnit === ControlUnit.HOURS) {
        await this.prisma.equipment.update({
          where: { id: reg.equipoId },
          data: { currentHourmeter: dto.valorFinal },
        });
      }
    }
    return reg;
  }
}
