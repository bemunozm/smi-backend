import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { TrabajosExtraService } from './trabajos-extra.service';
import { CreateTrabajoExtraDto } from './dto/create-trabajo-extra.dto';
import { UpdateTrabajoExtraDto } from './dto/update-trabajo-extra.dto';
import { Roles } from '../../../common/decorators/roles.decorator';

@Controller('trabajos-extra')
export class TrabajosExtraController {
  constructor(private readonly service: TrabajosExtraService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles('SUPERVISOR', 'ADMIN')
  create(@Body() dto: CreateTrabajoExtraDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('SUPERVISOR', 'ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateTrabajoExtraDto) {
    return this.service.update(id, dto);
  }
}
