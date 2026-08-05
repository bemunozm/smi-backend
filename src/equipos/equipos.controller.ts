// PROVISIONAL — dueño real: Amin (Flota). Solo lectura para poblar selects del
// front. Bajo el AuthGuard global (exige sesión); cualquier rol autenticado lee.
import { Controller, Get, Param } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Controller('equipos')
export class EquiposController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async findAll() {
    return {
      data: await this.prisma.equipo.findMany({ orderBy: { codigo: 'asc' } }),
      message: 'ok',
    };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return { data: await this.prisma.equipo.findUnique({ where: { id } }), message: 'ok' };
  }
}
