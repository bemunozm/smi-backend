import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CreateHallazgoDto } from './dto/create-hallazgo.dto';
import { UpdateHallazgoDto } from './dto/update-hallazgo.dto';

@Injectable()
export class HallazgosService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateHallazgoDto) {
    const equipo = await this.prisma.equipo.findUnique({ where: { id: dto.equipoId } });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    return this.prisma.hallazgo.create({
      data: {
        equipoId: dto.equipoId,
        descripcion: dto.descripcion,
        prioridad: dto.prioridad,
        estado: 'ABIERTO',
        fotoUrl: dto.fotoUrl ?? null,
      },
    });
  }

  findAll() {
    return this.prisma.hallazgo.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { codigo: true } } },
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.hallazgo.findUnique({ where: { id } });
    if (!reg) throw new NotFoundException('Hallazgo no encontrado');
    return reg;
  }

  update(id: string, dto: UpdateHallazgoDto) {
    return this.prisma.hallazgo.update({ where: { id }, data: dto });
  }
}
