import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateTrabajoExtraDto } from './dto/create-trabajo-extra.dto';
import { UpdateTrabajoExtraDto } from './dto/update-trabajo-extra.dto';

@Injectable()
export class TrabajosExtraService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateTrabajoExtraDto) {
    const equipo = await this.prisma.equipo.findUnique({ where: { id: dto.equipoId } });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    const monto = Number((dto.horasMaquina * dto.tarifa).toFixed(2));
    return this.prisma.trabajoExtraordinario.create({
      data: {
        equipoId: dto.equipoId,
        cliente: dto.cliente,
        horasMaquina: dto.horasMaquina,
        tonelaje: dto.tonelaje ?? null,
        tarifa: dto.tarifa,
        monto,
        fotoUrl: dto.fotoUrl ?? null,
      },
    });
  }

  findAll() {
    return this.prisma.trabajoExtraordinario.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { codigo: true } } },
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.trabajoExtraordinario.findUnique({ where: { id } });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }

  update(id: string, dto: UpdateTrabajoExtraDto) {
    return this.prisma.trabajoExtraordinario.update({ where: { id }, data: dto });
  }
}
