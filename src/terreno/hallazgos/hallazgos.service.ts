import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DOMAIN_EVENTS } from '../../common/events/domain-events';
import type { HallazgoCreatedEvent } from '../../common/events/domain-events';
import { CreateHallazgoDto } from './dto/create-hallazgo.dto';
import { UpdateHallazgoDto } from './dto/update-hallazgo.dto';

@Injectable()
export class HallazgosService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateHallazgoDto) {
    const equipo = await this.prisma.equipo.findUnique({
      where: { id: dto.equipoId },
    });
    if (!equipo) throw new NotFoundException('Equipo no encontrado');

    const hallazgo = await this.prisma.hallazgo.create({
      data: {
        equipoId: dto.equipoId,
        descripcion: dto.descripcion,
        prioridad: dto.prioridad,
        estado: 'ABIERTO',
        fotoUrl: dto.fotoUrl ?? null,
      },
    });

    this.eventEmitter.emit(DOMAIN_EVENTS.HALLAZGO_CREATED, {
      hallazgoId: hallazgo.id,
      equipoId: hallazgo.equipoId,
      prioridad: hallazgo.prioridad,
      descripcion: hallazgo.descripcion,
    } satisfies HallazgoCreatedEvent);

    return hallazgo;
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
