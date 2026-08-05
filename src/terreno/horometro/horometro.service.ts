import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { UpdateHorometroDto } from './dto/update-horometro.dto';

@Injectable()
export class HorometroService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateHorometroDto) {
    const equipo = await this.prisma.equipo.findUnique({ where: { id: dto.equipoId } });
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

    if (dto.valorFinal != null) {
      await this.prisma.equipo.update({
        where: { id: dto.equipoId },
        data: { horometroActual: dto.valorFinal },
      });
      // TODO(motor-preventivo): disparar el umbral de Mantenimiento (Joaquín, guía §5).
    }

    return registro;
  }

  findAll() {
    return this.prisma.registroHorometro.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { codigo: true } } },
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.registroHorometro.findUnique({ where: { id } });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }

  async update(id: string, dto: UpdateHorometroDto) {
    const reg = await this.prisma.registroHorometro.update({ where: { id }, data: dto });
    if (dto.valorFinal != null) {
      await this.prisma.equipo.update({
        where: { id: reg.equipoId },
        data: { horometroActual: dto.valorFinal },
      });
    }
    return reg;
  }
}
