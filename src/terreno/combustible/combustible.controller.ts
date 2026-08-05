import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles } from '@thallesp/nestjs-better-auth';

import { ROLES } from '../../auth/roles';
import { CombustibleService } from './combustible.service';
import { CreateCombustibleDto } from './dto/create-combustible.dto';
import { UpdateCombustibleDto } from './dto/update-combustible.dto';

@Controller('combustible')
export class CombustibleController {
  constructor(private readonly service: CombustibleService) {}

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
  async create(@Body() dto: CreateCombustibleDto) {
    return { data: await this.service.create(dto), message: 'Carga registrada' };
  }

  @Patch(':id')
  @Roles([ROLES.SUPERVISOR, ROLES.ADMIN])
  async update(@Param('id') id: string, @Body() dto: UpdateCombustibleDto) {
    return { data: await this.service.update(id, dto), message: 'Carga actualizada' };
  }
}
