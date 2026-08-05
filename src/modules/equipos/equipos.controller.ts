// PROVISIONAL — dueño real: Amin (Flota). Solo lectura para poblar selects del front.
import { Controller, Get, Param } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('equipos')
export class EquiposController {
  constructor(private prisma: PrismaService) {}

  @Get()
  findAll() {
    return this.prisma.equipo.findMany({ orderBy: { codigo: 'asc' } });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.prisma.equipo.findUnique({ where: { id } });
  }
}
