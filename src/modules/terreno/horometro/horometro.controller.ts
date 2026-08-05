import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../../auth/roles';
import { HorometroService } from './horometro.service';
import { CreateHorometroDto } from './dto/create-horometro.dto';
import { UpdateHorometroDto } from './dto/update-horometro.dto';

@Controller('horometro')
export class HorometroController {
  constructor(private readonly service: HorometroService) {}

  @Get()
  async findAll() {
    return { data: await this.service.findAll(), message: 'ok' };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return { data: await this.service.findOne(id), message: 'ok' };
  }

  @Post()
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async create(@Body() dto: CreateHorometroDto) {
    return { data: await this.service.create(dto), message: 'Lectura registrada' };
  }

  @Patch(':id')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async update(@Param('id') id: string, @Body() dto: UpdateHorometroDto) {
    return { data: await this.service.update(id, dto), message: 'Lectura actualizada' };
  }
}
