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

    // El registro de terreno y el write del contador de la ficha van en la
    // misma transacción: si el update del equipo fallara, no debe quedar un
    // `RegistroHorometro` huérfano que la ficha muestre sin haber movido el
    // contador (o viceversa).
    return this.prisma.$transaction(async (tx) => {
      const registro = await tx.registroHorometro.create({
        data: {
          equipoId: dto.equipoId,
          operador: dto.operador,
          turno: dto.turno,
          valorInicial: dto.valorInicial,
          valorFinal: dto.valorFinal ?? null,
          nivelCombustible: dto.nivelCombustible ?? null,
          fotoUrl: dto.fotoUrl ?? null,
        },
      });

      // El write del valor actual solo aplica al contador que gobierna la
      // unidad (RFC T01 §2, MEJORA-3): HOURS pisa `currentHourmeter`, KM pisa
      // `currentMileage` — nunca los dos a la vez.
      if (dto.valorFinal != null) {
        if (equipo.controlUnit === ControlUnit.HOURS) {
          await tx.equipment.update({
            where: { id: dto.equipoId },
            data: { currentHourmeter: dto.valorFinal },
          });
          // TODO(motor-preventivo): disparar el umbral de Mantenimiento (Joaquín, guía §5).
        } else if (equipo.controlUnit === ControlUnit.KM) {
          await tx.equipment.update({
            where: { id: dto.equipoId },
            data: { currentMileage: dto.valorFinal },
          });
        }
      }

      return registro;
    });
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
    // Mismo criterio de atomicidad que `create()`: el registro editado y el
    // write del contador (si `valorFinal` cambia) van en la misma transacción.
    return this.prisma.$transaction(async (tx) => {
      const reg = await tx.registroHorometro.update({
        where: { id },
        data: dto,
      });

      if (dto.valorFinal != null) {
        const equipo = await tx.equipment.findUnique({
          where: { id: reg.equipoId },
          select: { controlUnit: true },
        });
        if (equipo?.controlUnit === ControlUnit.HOURS) {
          await tx.equipment.update({
            where: { id: reg.equipoId },
            data: { currentHourmeter: dto.valorFinal },
          });
        } else if (equipo?.controlUnit === ControlUnit.KM) {
          await tx.equipment.update({
            where: { id: reg.equipoId },
            data: { currentMileage: dto.valorFinal },
          });
        }
      }

      return reg;
    });
  }
}
