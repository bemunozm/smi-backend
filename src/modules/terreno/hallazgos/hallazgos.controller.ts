import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { HallazgosService } from './hallazgos.service';
import { CreateHallazgoDto } from './dto/create-hallazgo.dto';
import { UpdateHallazgoDto } from './dto/update-hallazgo.dto';
import { Roles } from '../../../common/decorators/roles.decorator';

@Controller('hallazgos')
export class HallazgosController {
  constructor(private readonly service: HallazgosService) {}

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
  create(@Body() dto: CreateHallazgoDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('SUPERVISOR', 'ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateHallazgoDto) {
    return this.service.update(id, dto);
  }
}
