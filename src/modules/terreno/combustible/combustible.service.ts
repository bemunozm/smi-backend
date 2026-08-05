import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateCombustibleDto } from './dto/create-combustible.dto';
import { UpdateCombustibleDto } from './dto/update-combustible.dto';

@Injectable()
export class CombustibleService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateCombustibleDto) {
    const equipo = await this.prisma.equipo.findUnique({ where: { id: dto.equipoId } });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    let rendimiento: number | null = null;
    if (dto.lecturaActual != null && dto.litros > 0) {
      const delta = dto.lecturaActual - equipo.horometroActual;
      rendimiento = delta > 0 ? Number((delta / dto.litros).toFixed(2)) : null;
    }

    return this.prisma.registroCombustible.create({
      data: { equipoId: dto.equipoId, litros: dto.litros, fotoUrl: dto.fotoUrl ?? null, rendimiento },
    });
  }

  findAll() {
    return this.prisma.registroCombustible.findMany({
      orderBy: { fecha: 'desc' },
      include: { equipo: { select: { codigo: true } } },
    });
  }

  async findOne(id: string) {
    const reg = await this.prisma.registroCombustible.findUnique({ where: { id } });
    if (!reg) throw new NotFoundException('Registro no encontrado');
    return reg;
  }

  update(id: string, dto: UpdateCombustibleDto) {
    return this.prisma.registroCombustible.update({ where: { id }, data: dto });
  }
}
