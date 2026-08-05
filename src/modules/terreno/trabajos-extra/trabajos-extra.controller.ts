import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../../auth/roles';
import { TrabajosExtraService } from './trabajos-extra.service';
import { CreateTrabajoExtraDto } from './dto/create-trabajo-extra.dto';
import { UpdateTrabajoExtraDto } from './dto/update-trabajo-extra.dto';

@Controller('trabajos-extra')
export class TrabajosExtraController {
  constructor(private readonly service: TrabajosExtraService) {}

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
  async create(@Body() dto: CreateTrabajoExtraDto) {
    return { data: await this.service.create(dto), message: 'Trabajo registrado' };
  }

  @Patch(':id')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async update(@Param('id') id: string, @Body() dto: UpdateTrabajoExtraDto) {
    return { data: await this.service.update(id, dto), message: 'Trabajo actualizado' };
  }
}
