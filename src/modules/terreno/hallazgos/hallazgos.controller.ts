import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../../auth/roles';
import { HallazgosService } from './hallazgos.service';
import { CreateHallazgoDto } from './dto/create-hallazgo.dto';
import { UpdateHallazgoDto } from './dto/update-hallazgo.dto';

@Controller('hallazgos')
export class HallazgosController {
  constructor(private readonly service: HallazgosService) {}

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
  async create(@Body() dto: CreateHallazgoDto) {
    return { data: await this.service.create(dto), message: 'Hallazgo registrado' };
  }

  @Patch(':id')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async update(@Param('id') id: string, @Body() dto: UpdateHallazgoDto) {
    return { data: await this.service.update(id, dto), message: 'Hallazgo actualizado' };
  }
}
